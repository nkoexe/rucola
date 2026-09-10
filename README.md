# Rucola

Rucola is a small, offline-first Android mailbox for two people. The local Room database is the permanent history; synchronization is represented in the domain model but networking is intentionally not implemented yet.

## Build and run

Open the project in Android Studio, or run `gradle assembleDebug` with Android SDK platform 35 installed. Install `app/build/outputs/apk/debug/app-debug.apk` on a device or emulator.

Run unit tests with `gradle testDebugUnitTest`. The release variant is currently unsigned by design; signing can be supplied later through CI secrets without putting credentials in the repository.

The app starts with local setup, then supports a partner message view, text/emoji/photo-video/drawing message placeholders, and horizontal swipe navigation into immutable local history.
