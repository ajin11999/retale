import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Load key.properties if it exists (CI writes it from secrets;
// local dev falls back to debug signing — see the else branch below).
val keyProperties = Properties()
val keyPropertiesFile = rootProject.file("key.properties")
val hasKeyProperties = keyPropertiesFile.exists()
if (hasKeyProperties) {
    keyPropertiesFile.inputStream().use { keyProperties.load(it) }
}

android {
    namespace = "com.retale.retale_stockeeper"
    // mobile_scanner needs compileSdk 36 + NDK 27 (Flutter 3.29's defaults are lower).
    compileSdk = 36
    ndkVersion = "27.0.12077973"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.retale.retale_stockeeper"
        // mobile_scanner requires API 23+ (Flutter's default is 21).
        minSdk = 23
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    if (hasKeyProperties) {
        signingConfigs {
            create("release") {
                keyAlias     = keyProperties["keyAlias"] as String
                keyPassword  = keyProperties["keyPassword"] as String
                storeFile    = file(keyProperties["storeFile"] as String)
                storePassword = keyProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasKeyProperties) {
                signingConfigs.getByName("release")
            } else {
                // No keystore available (local dev) — use debug keys so
                // `flutter run --release` still works out of the box.
                signingConfigs.getByName("debug")
            }
        }
    }
}

flutter {
    source = "../.."
}
