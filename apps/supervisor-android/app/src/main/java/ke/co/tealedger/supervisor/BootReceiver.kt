package ke.co.tealedger.supervisor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restores durable network-constrained sync after a device restart without starting a UI. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (SecureSyncStore(context.applicationContext).hasPendingEvents()) {
            PendingSyncScheduler.schedule(context.applicationContext, requestForegroundWatcher = false)
        }
    }
}
