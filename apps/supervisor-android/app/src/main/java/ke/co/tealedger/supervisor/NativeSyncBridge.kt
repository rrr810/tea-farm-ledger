package ke.co.tealedger.supervisor

import android.content.Context
import android.webkit.JavascriptInterface

/**
 * Deliberately small WebView bridge. It has no API for SMS, users, phones,
 * private-ID records, raw roster reading, or arbitrary network requests.
 */
class NativeSyncBridge(context: Context) {
    private val appContext = context.applicationContext
    private val store = SecureSyncStore(appContext)

    @JavascriptInterface
    fun saveDeviceAccess(json: String) {
        store.saveDeviceAccess(json)
    }

    @JavascriptInterface
    fun queueEvents(json: String) {
        store.queueEvents(json)
        if (store.hasPendingEvents()) {
            PendingSyncScheduler.schedule(appContext, requestForegroundWatcher = true)
        }
    }

    @JavascriptInterface
    fun removeQueuedEvents(json: String) {
        store.removeQueuedEvents(json)
        if (!store.hasPendingEvents()) {
            appContext.stopService(android.content.Intent(appContext, PendingSyncForegroundService::class.java))
        }
    }

    @JavascriptInterface
    fun takeAcknowledgedEventIds(): String = store.takeAcknowledgedEventIdsJson()

    @JavascriptInterface
    fun hasPendingEvents(): Boolean = store.hasPendingEvents()

    @JavascriptInterface
    fun clearSyncState() {
        store.clearAll()
        PendingSyncScheduler.cancel(appContext)
    }

    @JavascriptInterface
    fun startPendingSync() {
        if (store.hasPendingEvents()) {
            PendingSyncScheduler.schedule(appContext, requestForegroundWatcher = true)
        }
    }
}
