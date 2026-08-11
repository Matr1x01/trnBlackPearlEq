plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.trncontrol.blackpearl"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.trncontrol.blackpearl"
        // Android 8.0. Covers effectively every phone with usable USB host
        // support, and lets the launcher icon be pure XML (adaptive icons)
        // instead of a set of committed PNGs.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.1"
    }

    buildTypes {
        release {
            // Left off deliberately: the release build is a sideloaded APK,
            // and R8 would need keep rules for every class gomobile reflects
            // over. Not worth the debugging for ~200 KB.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        // AGP 8 stopped generating BuildConfig by default; MainActivity uses
        // DEBUG (to gate WebView remote debugging) and VERSION_CODE (to
        // decide when to re-unpack the web UI).
        buildConfig = true
    }

    packaging {
        // The AAR ships one .so per ABI; nothing to deduplicate, but keep
        // the legal noise out of the APK.
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }

    sourceSets {
        // Where copyWebUi (below) stages the built frontend.
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("webui"))
        }
    }
}

dependencies {
    // The Go backend: api + presets + hidproto, built by `gomobile bind`.
    // Produced by the build script, not downloaded -- see android/README.md.
    implementation(files("libs/trncontrol.aar"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

/**
 * Copies the built web UI into the APK's assets.
 *
 * The frontend is not duplicated in this project -- it is built once at
 * ../../frontend and copied in here, so the Android app can never drift from
 * the desktop UI. Run `npm run build` in frontend/ first; the check below
 * fails loudly rather than shipping an APK with a blank screen.
 */
val webUiSource = rootProject.file("../frontend/dist")

val copyWebUi by tasks.registering(Copy::class) {
    from(webUiSource)
    into(layout.buildDirectory.dir("webui/webui"))
    doFirst {
        if (!webUiSource.resolve("index.html").exists()) {
            throw GradleException(
                "Frontend not built: ${webUiSource.resolve("index.html")} is missing.\n" +
                    "Run `npm run build` in the frontend/ directory first."
            )
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebUi) }
