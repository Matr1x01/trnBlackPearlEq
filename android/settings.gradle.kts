pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The Go backend, built by `gomobile bind` into app/libs/trncontrol.aar.
        // See android/README.md -- this is not fetched, it is produced locally.
        flatDir { dirs("app/libs") }
    }
}

rootProject.name = "TRN Black Pearl Control"
include(":app")
