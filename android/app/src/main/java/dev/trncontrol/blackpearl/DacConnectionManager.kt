package dev.trncontrol.blackpearl

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dev.trncontrol.backend.mobile.Mobile
import dev.trncontrol.backend.mobile.USBTransport

/**
 * Owns the USB side of the app's lifecycle: finding the DAC, getting
 * permission for it, and telling the Go backend when it comes and goes.
 *
 * The backend deliberately does no USB discovery of its own on Android (it
 * cannot -- there is no hidraw), so this class is the sole route by which a
 * connection reaches it. That mirrors the desktop `connectLoop`, except the
 * trigger is a system broadcast rather than a poll, which is both faster and
 * cheaper on battery.
 */
class DacConnectionManager(
    private val context: Context,
    private val onStateChanged: (Boolean) -> Unit,
) {

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val device = intent.usbDevice()
                    if (granted && device != null) {
                        Log.i(TAG, "USB permission granted")
                        attach(device)
                    } else {
                        Log.w(TAG, "USB permission denied")
                        onStateChanged(false)
                    }
                }

                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    intent.usbDevice()
                        ?.takeIf { UsbHidTransport.matches(it) }
                        ?.let { connect(it) }
                }

                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val device = intent.usbDevice()
                    if (device == null || UsbHidTransport.matches(device)) {
                        Log.i(TAG, "DAC detached")
                        // Tear down explicitly rather than waiting for I/O to
                        // fail: reads cannot tell a timeout from a dead
                        // device, so this broadcast is the reliable signal.
                        Mobile.detachDevice()
                        onStateChanged(false)
                    }
                }
            }
        }
    }

    fun register() {
        if (registered) return
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(
            context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
        registered = true
    }

    fun unregister() {
        if (!registered) return
        context.unregisterReceiver(receiver)
        registered = false
    }

    /**
     * Looks for an already-attached DAC and connects to it. Called on
     * startup and on resume -- the device is usually plugged in before the
     * app is opened, in which case no ATTACHED broadcast is coming.
     */
    fun connectIfPresent() {
        if (Mobile.isDeviceAttached()) {
            onStateChanged(true)
            return
        }
        val device = usbManager.deviceList.values.firstOrNull { UsbHidTransport.matches(it) }
        if (device == null) {
            Log.i(TAG, "no DAC attached")
            onStateChanged(false)
            return
        }
        connect(device)
    }

    /** Requests permission if needed, then opens the device. */
    fun connect(device: UsbDevice) {
        if (!usbManager.hasPermission(device)) {
            Log.i(TAG, "requesting USB permission for ${device.deviceName}")
            usbManager.requestPermission(device, permissionIntent())
            return
        }
        attach(device)
    }

    private fun attach(device: UsbDevice) {
        try {
            val connection = usbManager.openDevice(device)
                ?: throw IllegalStateException("openDevice returned null (permission revoked?)")
            val transport = UsbHidTransport.open(device, connection)
            Mobile.attachDevice(GoTransportBridge(transport))
            Log.i(TAG, "DAC attached and handed to the backend")
            onStateChanged(true)
        } catch (e: Exception) {
            Log.e(TAG, "failed to attach DAC", e)
            onStateChanged(false)
        }
    }

    fun detach() {
        Mobile.detachDevice()
        onStateChanged(false)
    }

    private fun permissionIntent(): PendingIntent {
        // The system writes EXTRA_DEVICE and EXTRA_PERMISSION_GRANTED into
        // this intent, so on Android 12+ it must be mutable. FLAG_IMMUTABLE
        // here yields a permission result that never contains a device.
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION).setPackage(context.packageName), flags
        )
    }

    @Suppress("DEPRECATION")
    private fun Intent.usbDevice(): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    companion object {
        private const val TAG = "TRNUsb"
        private const val ACTION_USB_PERMISSION = "dev.trncontrol.blackpearl.USB_PERMISSION"
    }
}

/**
 * Adapts [UsbHidTransport] to the interface gomobile generated for the Go
 * `mobile.USBTransport`.
 *
 * It exists only to bridge the two signatures: gomobile maps Go's `int` to
 * `long` and its `(value, error)` returns to a value plus a thrown
 * exception, which is not a shape worth imposing on the USB code itself.
 */
private class GoTransportBridge(private val transport: UsbHidTransport) : USBTransport {

    @Throws(Exception::class)
    override fun write(p: ByteArray) = transport.write(p)

    @Throws(Exception::class)
    override fun read(timeoutMs: Long): ByteArray = transport.read(timeoutMs)

    @Throws(Exception::class)
    override fun close() = transport.close()
}
