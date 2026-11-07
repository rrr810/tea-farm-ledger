# Tea Ledger Supervisor for Android (private test build)

This Android-only shell hosts the existing canonical Supervisor PWA and adds a narrow native sync path for completed, device-bound ledger events.

## What it does

- Opens only the canonical Tea Ledger Supervisor app in a locked-down Android WebView.
- Mirrors the existing opaque field-device credential into Android Keystore-backed encrypted storage. It never mirrors a Supervisor identity session, worker ID photo, national-ID draft, SMS token, or recipient configuration.
- Mirrors only events that have already been persisted in the PWA outbox. The PWA sends a completed daily batch (all entries plus `day.confirmed`) to the native bridge together, so native background work cannot upload a half-entered day.
- Keeps a visible **Sync pending** foreground notification while completed work waits for connectivity.
- Uses persistent Android WorkManager work with a network constraint. It retries after network returns, restarts, and ordinary app closure.
- Posts to the same authenticated `/api/sync/push` endpoint using the farm-bound device credential. SMS can therefore fire only after the server accepts the batch.
- Treats server event IDs as idempotency keys. If the browser and native worker race, the server retains a duplicate as history and does not send a second daily/weekly SMS.

## Important operating limit

Android controls the exact moment background work can run. The foreground notification and expedited WorkManager job are the strongest practical option, but no mobile OS can promise literal zero-second network wake-up in every battery/coverage state. The app preserves the batch and retries until the server accepts it.

## Build a test APK

This workspace includes the Gradle wrapper but does not include an Android SDK or release signing key. Open `apps/supervisor-android/` in Android Studio with JDK 17 and Android SDK 35, then choose **Build > Build APK(s)**, or run `./gradlew :app:assembleDebug`, for a test/debug APK. The current user-approved phase is **unsigned/test APK first**; do not add a signing key to Git.

Before distribution, test on an approved Android phone:

1. Open the app online once and enrol/sign in through the existing Supervisor screen.
2. Turn on the app notification permission and follow its battery-unrestricted guidance.
3. Turn off data, enter a genuine test day only in a non-production test farm, and press Done.
4. Close the app, restore data, and observe the Sync pending notification clear only after the server accepts the batch.
5. Verify on the Admin delivery log without exposing worker identities or phone numbers.

The native app does not itself send SMS or create a fake day. Production SMS is still governed by the server-side accepted-event workflow.
