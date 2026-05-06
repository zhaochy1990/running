plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "cn.striderunning.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "cn.striderunning.app"
        minSdk = 26  // Android 8.0 (Oreo) — Health Connect-eligible, ~98% device coverage. Decided in plan O2.
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // JPush 极光推送 manifest placeholders.
        // Real production AppKey: ab305c4addc8f9aa2b5efb4c (public; OK to commit).
        // Master Secret is server-side only (Azure Key Vault).
        // Per plan O5/F2: dev/prod use the same AppKey for v1.
        manifestPlaceholders["JPUSH_APPKEY"] = "ab305c4addc8f9aa2b5efb4c"
        manifestPlaceholders["JPUSH_CHANNEL"] = "default"
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}
