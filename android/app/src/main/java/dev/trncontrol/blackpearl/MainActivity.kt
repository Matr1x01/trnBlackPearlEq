package dev.trncontrol.blackpearl

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import dev.trncontrol.backend.mobile.Logger
import dev.trncontrol.backend.mobile.Mobile
import java.io.File

/**
 * The whole app: start the Go backend, point a WebView at it, keep the USB
 * connection in sync.
 *
 * The UI is the same React frontend the desktop build ships -- it is served
 * by the Go server on loopback rather than loaded from `file://` or
 * `WebViewAssetLoader`, which makes it same-origin with the API. That
 * sidesteps both CORS and the WebView's mixed-content blocking (an https
 * asset origin calling an http loopback API), neither of which has a tidy
 * answer otherwise.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var usb: DacConnectionManager
    private var port: Int = 0

    // Backs WebChromeClient.onShowFileChooser (import preset). Must be
    // registered unconditionally as a field -- ActivityResultContracts
    // require registration before STARTED, so this cannot move into
    // onCreate.
    private var filePickerCallback: ValueCallback<Array<Uri>>? = null
    private val filePickerLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
            filePickerCallback?.onReceiveValue(uri?.let { arrayOf(it) })
            filePickerCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Mobile.setLogger(Logger { msg -> Log.i(TAG_BACKEND, msg.trimEnd()) })

        val webRoot = try {
            extractWebUi()
        } catch (e: Exception) {
            Log.e(TAG, "failed to unpack the web UI", e)
            ""
        }

        port = try {
            Mobile.start(filesDir.absolutePath, webRoot).toInt()
        } catch (e: Exception) {
            Log.e(TAG, "backend failed to start", e)
            0
        }
        Log.i(TAG, "backend on 127.0.0.1:$port")

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        setContentView(webView)
        configureWebView()

        // Android 15's targetSdk enforces edge-to-edge with no opt-out, so
        // without this the page content would draw under the status/nav
        // bars. Handled in CSS instead of here: see the safe-area-inset-top
        // rule on .app-header in App.css and the viewport-fit=cover meta tag
        // in index.html. Native View padding on the WebView was tried first
        // and did not reliably apply; env() in CSS does.

        usb = DacConnectionManager(this) { connected ->
            Log.i(TAG, "DAC connected=$connected")
        }
        usb.register()

        if (port != 0) {
            // `api=same-origin` tells the frontend to use relative URLs
            // instead of the desktop's fixed 127.0.0.1:47823. See
            // frontend/src/api/client.ts.
            webView.loadUrl("http://127.0.0.1:$port/?api=same-origin")
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        // Launched by the ATTACHED intent filter: the DAC is already there.
        handleUsbIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleUsbIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        // The DAC is usually plugged in before the app is opened, so there is
        // no ATTACHED broadcast to wait for.
        usb.connectIfPresent()
    }

    override fun onDestroy() {
        usb.unregister()
        // Only stop the backend on a real finish, not on a configuration
        // change -- restarting it would drop the USB connection and rebind a
        // different port for no reason.
        if (isFinishing) {
            Mobile.stop()
        }
        super.onDestroy()
    }

    private fun handleUsbIntent(intent: Intent?) {
        if (intent?.action == android.hardware.usb.UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            usb.connectIfPresent()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The UI is local; nothing here should reach the network.
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        }
        webView.webViewClient = object : WebViewClient() {
            // Keep everything inside the app except genuinely external links,
            // which are handed to the browser.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val host = request.url.host ?: return false
                if (host == "127.0.0.1" || host == "localhost") return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // Backs the frontend's "Import" button (a hidden <input
            // type="file">, see PresetGallery.tsx) -- without this override
            // the WebView silently no-ops on a file input click, since a
            // plain WebView has no default UI for it.
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePickerCallback?.onReceiveValue(null)
                filePickerCallback = callback
                val mime = params.acceptTypes.firstOrNull { it.contains('/') }
                    ?: "application/json"
                filePickerLauncher.launch(mime)
                return true
            }
        }
    }

    /**
     * Unpacks the bundled frontend into private storage so the Go file
     * server can read it -- APK assets live inside the archive and have no
     * filesystem path.
     *
     * Re-extracted whenever the app version changes; a marker file keeps
     * ordinary launches from paying for it.
     */
    private fun extractWebUi(): String {
        val target = File(filesDir, "webui")
        val stamp = File(target, ".version")
        val version = BuildConfig.VERSION_CODE.toString()

        if (stamp.isFile && stamp.readText() == version) {
            return target.absolutePath
        }

        target.deleteRecursively()
        target.mkdirs()
        copyAsset("webui", target)
        stamp.writeText(version)
        Log.i(TAG, "unpacked web UI to $target")
        return target.absolutePath
    }

    private fun copyAsset(path: String, target: File) {
        val children = assets.list(path) ?: emptyArray()
        if (children.isEmpty()) {
            // A leaf: assets.list returns nothing for files.
            target.parentFile?.mkdirs()
            assets.open(path).use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
            return
        }
        target.mkdirs()
        for (child in children) {
            copyAsset("$path/$child", File(target, child))
        }
    }

    private companion object {
        const val TAG = "TRNMain"
        const val TAG_BACKEND = "TRNBackend"
    }
}
