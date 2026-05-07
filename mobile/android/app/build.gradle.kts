import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Load android/key.properties if present (CI writes it from secrets; local
// devs can drop one in for ad-hoc release builds). Without it, the release
// build falls back to the debug signing config so `flutter run --release`
// keeps working without ceremony.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        load(FileInputStream(keystorePropertiesFile))
    }
}
val hasUploadKey = keystorePropertiesFile.exists()

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

    signingConfigs {
        if (hasUploadKey) {
            create("release") {
                storeFile = rootProject.file("app/${keystoreProperties["storeFile"]}")
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasUploadKey) {
                signingConfigs.getByName("release")
            } else {
                // Fallback for local dev: debug signing so `flutter run
                // --release` doesn't need the production keystore.
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}
