/// Which build is this?
///
/// Answering that from inside the app is not a nicety. The APK is delivered by
/// file sync rather than a store, so there is no update prompt and no version
/// screen — "is the new one actually installed?" is otherwise only answerable by
/// hunting for a feature that shipped with it, which is exactly as slow as it
/// sounds.
///
/// Stamped at compile time. `scripts/build-apk.sh` passes the values; a plain
/// `flutter run` gets the `dev` defaults, which is itself informative.
library;

const String appVersion = String.fromEnvironment('CC_VERSION', defaultValue: '0.0.0');

/// UTC build time, `YYYY-MM-DD HH:MM`. Empty outside a scripted build.
const String buildStamp = String.fromEnvironment('CC_BUILD');

/// One line for the UI: `v1.0.0 · 2026-08-13 14:52 UTC`, or `v0.0.0 · dev build`.
String get buildLabel =>
    'v$appVersion · ${buildStamp.isEmpty ? 'dev build' : '$buildStamp UTC'}';
