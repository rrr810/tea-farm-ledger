package ke.co.tealedger.supervisor

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sends only an encrypted, completed native outbox through the same farm-bound
 * device-authentication endpoint used by the Supervisor PWA. SMS remains a
 * server-side side effect of accepted events; this worker never contacts an
 * SMS provider.
 */
class PendingSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {
    override fun doWork(): Result {
        val store = SecureSyncStore(applicationContext)
        val access = store.deviceAccess() ?: return Result.failure()
        val events = store.orderedEvents()
        if (events.isEmpty()) {
            stopWatcherIfIdle(store)
            return Result.success()
        }

        return try {
            val payload = JSONArray()
            events.forEach { payload.put(it.payload) }
            val connection = (URL("$API_BASE_URL/api/sync/push").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 30_000
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Tea-Device-Id", access.deviceId)
                setRequestProperty("X-Tea-Device-Token", access.deviceToken)
            }
            connection.outputStream.use { output ->
                output.write(JSONObject().put("events", payload).toString().toByteArray(Charsets.UTF_8))
            }
            val status = connection.responseCode
            // Consume/close the response without storing potentially sensitive
            // server messages in native logs or notifications.
            runCatching { (if (status in 200..299) connection.inputStream else connection.errorStream)?.close() }
            connection.disconnect()

            if (status in 200..299) {
                // A successful sync response means every submitted event was
                // either newly accepted or an idempotent duplicate. Both are
                // safe to clear locally; a 4xx/5xx result is never cleared.
                store.acknowledgeSubmitted(events.map { it.eventId })
                if (store.hasPendingEvents()) {
                    PendingSyncScheduler.schedule(applicationContext, requestForegroundWatcher = false)
                } else {
                    stopWatcherIfIdle(store)
                }
                Result.success()
            } else if (status in 400..499) {
                // Re-enrolment, a FINAL precondition, or malformed data needs
                // a human/PWA correction; do not hammer the API automatically.
                Result.failure()
            } else {
                Result.retry()
            }
        } catch (_: Exception) {
            // Network loss and provider edge failures retain the encrypted
            // outbox unchanged. WorkManager will retry under its network rule.
            Result.retry()
        }
    }

    private fun stopWatcherIfIdle(store: SecureSyncStore) {
        if (!store.hasPendingEvents()) {
            applicationContext.stopService(Intent(applicationContext, PendingSyncForegroundService::class.java))
        }
    }

    private companion object {
        const val API_BASE_URL = "https://tea-farm-ledger.vercel.app"
    }
}
