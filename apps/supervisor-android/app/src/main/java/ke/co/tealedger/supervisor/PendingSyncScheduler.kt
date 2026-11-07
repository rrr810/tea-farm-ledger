package ke.co.tealedger.supervisor

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager

/** Schedules durable network-bound work and, when permitted, a visible foreground watcher. */
object PendingSyncScheduler {
    private const val UNIQUE_WORK_NAME = "tea-ledger-pending-sync"

    fun cancel(context: Context) {
        val appContext = context.applicationContext
        WorkManager.getInstance(appContext).cancelUniqueWork(UNIQUE_WORK_NAME)
        appContext.stopService(Intent(appContext, PendingSyncForegroundService::class.java))
    }

    fun schedule(context: Context, requestForegroundWatcher: Boolean) {
        val appContext = context.applicationContext
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val work = OneTimeWorkRequestBuilder<PendingSyncWorker>()
            .setConstraints(constraints)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(UNIQUE_WORK_NAME)
            .build()
        WorkManager.getInstance(appContext)
            .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, work)

        if (requestForegroundWatcher && SecureSyncStore(appContext).hasPendingEvents()) {
            try {
                ContextCompat.startForegroundService(
                    appContext,
                    Intent(appContext, PendingSyncForegroundService::class.java),
                )
            } catch (_: Exception) {
                // WorkManager is the persistent fallback if Android rejects a
                // foreground-service start due to an OS state restriction.
            }
        }
    }
}
