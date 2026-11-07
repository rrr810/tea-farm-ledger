package ke.co.tealedger.supervisor

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.util.regex.Pattern

/**
 * Stores the opaque enrolled-device credential and queued append-only events in
 * Android Keystore-backed encrypted preferences. No Supervisor session token,
 * private identity draft, photo, SMS token, or recipient data is stored here.
 */
@Suppress("DEPRECATION")
class SecureSyncStore(context: Context) {
    data class DeviceAccess(
        val farmId: String,
        val deviceId: String,
        val deviceToken: String,
    )

    data class QueuedEvent(
        val eventId: String,
        val farmId: String,
        val type: String,
        val createdAt: String,
        val payload: JSONObject,
    )

    private val lock = Any()
    private val masterKey = MasterKey.Builder(context.applicationContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    private val preferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        PREFS_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun saveDeviceAccess(raw: String): Boolean = synchronized(lock) {
        val candidate = runCatching { JSONObject(raw) }.getOrNull() ?: return false
        val farmId = candidate.optString("farmId")
        val deviceId = candidate.optString("deviceId")
        val deviceToken = candidate.optString("deviceToken")
        if (!isUuid(farmId) || !isUuid(deviceId) || deviceToken.length < 32) return false

        // A native installation is bound to exactly one farm. A newly enrolled
        // farm clears old encrypted event mirrors rather than mixing tenancies.
        val previous = deviceAccess()
        val editor = preferences.edit().putString(
            DEVICE_ACCESS_KEY,
            JSONObject()
                .put("farmId", farmId)
                .put("deviceId", deviceId)
                .put("deviceToken", deviceToken)
                .toString(),
        )
        if (previous != null && previous.farmId != farmId) {
            editor.remove(EVENTS_KEY).remove(ACKNOWLEDGED_KEY)
        }
        editor.apply()
        true
    }

    fun deviceAccess(): DeviceAccess? = synchronized(lock) {
        val raw = preferences.getString(DEVICE_ACCESS_KEY, null) ?: return null
        val value = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val farmId = value.optString("farmId")
        val deviceId = value.optString("deviceId")
        val deviceToken = value.optString("deviceToken")
        if (!isUuid(farmId) || !isUuid(deviceId) || deviceToken.length < 32) return null
        DeviceAccess(farmId, deviceId, deviceToken)
    }

    /**
     * Adds only well-formed, farm/device-bound events. Repeated bridge calls
     * deduplicate by event ID, so reopening the WebView cannot grow the queue.
     */
    fun queueEvents(raw: String): Int = synchronized(lock) {
        val access = deviceAccess() ?: return 0
        val incoming = runCatching { JSONArray(raw) }.getOrNull() ?: return 0
        val stored = readArray(EVENTS_KEY)
        val knownIds = mutableSetOf<String>().apply {
            for (index in 0 until stored.length()) {
                add(stored.optJSONObject(index)?.optString("event_id").orEmpty())
            }
        }
        var added = 0
        for (index in 0 until incoming.length()) {
            val event = incoming.optJSONObject(index) ?: continue
            val eventId = event.optString("event_id")
            val farmId = event.optString("farm_id")
            val type = event.optString("type")
            val createdAt = event.optString("createdAt")
            val payload = event.optJSONObject("payload") ?: continue
            val payloadFarmId = payload.optString("farm_id")
            val payloadDeviceId = payload.optString("device_id")
            if (
                !isUuid(eventId) ||
                farmId != access.farmId ||
                payloadFarmId != access.farmId ||
                payloadDeviceId != access.deviceId ||
                type.isBlank() ||
                createdAt.isBlank() ||
                knownIds.contains(eventId)
            ) continue
            stored.put(event)
            knownIds.add(eventId)
            added++
        }
        if (added > 0) preferences.edit().putString(EVENTS_KEY, stored.toString()).apply()
        added
    }

    fun orderedEvents(): List<QueuedEvent> = synchronized(lock) {
        val access = deviceAccess() ?: return emptyList()
        val values = mutableListOf<QueuedEvent>()
        val stored = readArray(EVENTS_KEY)
        for (index in 0 until stored.length()) {
            val event = stored.optJSONObject(index) ?: continue
            val eventId = event.optString("event_id")
            val farmId = event.optString("farm_id")
            val payload = event.optJSONObject("payload") ?: continue
            val type = event.optString("type")
            val createdAt = event.optString("createdAt")
            if (
                !isUuid(eventId) ||
                farmId != access.farmId ||
                payload.optString("farm_id") != access.farmId ||
                payload.optString("device_id") != access.deviceId ||
                type.isBlank() ||
                createdAt.isBlank()
            ) continue
            values.add(QueuedEvent(eventId, farmId, type, createdAt, payload))
        }
        // FINAL is always last. The server independently applies the same
        // ordering, so a stale/native queue can never lock Saturday first.
        values.sortedWith(
            compareBy<QueuedEvent> { if (it.type == "week.submitted") 1 else 0 }
                .thenBy { it.createdAt }
                .thenBy { it.eventId },
        )
    }

    /** Removes only the exact IDs submitted in a successful HTTP 2xx batch. */
    fun acknowledgeSubmitted(eventIds: Collection<String>) = synchronized(lock) {
        if (eventIds.isEmpty()) return@synchronized
        val ids = eventIds.toSet()
        val stored = readArray(EVENTS_KEY)
        val remaining = JSONArray()
        for (index in 0 until stored.length()) {
            val event = stored.optJSONObject(index) ?: continue
            if (!ids.contains(event.optString("event_id"))) remaining.put(event)
        }
        val acknowledged = readArray(ACKNOWLEDGED_KEY)
        val alreadyAcknowledged = buildSet {
            for (index in 0 until acknowledged.length()) add(acknowledged.optString(index))
        }
        for (eventId in eventIds) {
            if (isUuid(eventId) && !alreadyAcknowledged.contains(eventId)) acknowledged.put(eventId)
        }
        preferences.edit()
            .putString(EVENTS_KEY, remaining.toString())
            .putString(ACKNOWLEDGED_KEY, acknowledged.toString())
            .apply()
    }

    /** Browser-side sync already succeeded; discard only its native mirror. */
    fun removeQueuedEvents(raw: String) = synchronized(lock) {
        val ids = runCatching { JSONArray(raw) }.getOrNull() ?: return@synchronized
        val remove = buildSet {
            for (index in 0 until ids.length()) {
                val id = ids.optString(index)
                if (isUuid(id)) add(id)
            }
        }
        if (remove.isEmpty()) return@synchronized
        val remaining = JSONArray()
        val stored = readArray(EVENTS_KEY)
        for (index in 0 until stored.length()) {
            val event = stored.optJSONObject(index) ?: continue
            if (!remove.contains(event.optString("event_id"))) remaining.put(event)
        }
        preferences.edit().putString(EVENTS_KEY, remaining.toString()).apply()
    }

    /** Returned once to the PWA when it next foregrounds, then cleared. */
    fun takeAcknowledgedEventIdsJson(): String = synchronized(lock) {
        val raw = preferences.getString(ACKNOWLEDGED_KEY, "[]") ?: "[]"
        preferences.edit().remove(ACKNOWLEDGED_KEY).apply()
        raw
    }

    fun hasPendingEvents(): Boolean = synchronized(lock) { readArray(EVENTS_KEY).length() > 0 }

    /**
     * Used only after the PWA has checked that its browser-side outbox and
     * local daily draft are empty, and a server-approved field-device relink
     * has issued a fresh credential. This prevents a prior farm's encrypted
     * token or queued mirror from surviving a deliberate device handover.
     */
    fun clearAll(): Unit = synchronized(lock) {
        preferences.edit().clear().apply()
    }

    private fun readArray(key: String): JSONArray {
        val raw = preferences.getString(key, "[]") ?: "[]"
        return runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
    }

    private fun isUuid(value: String): Boolean = UUID_PATTERN.matcher(value).matches()

    private companion object {
        const val PREFS_NAME = "tea_ledger_native_sync"
        const val DEVICE_ACCESS_KEY = "device_access"
        const val EVENTS_KEY = "outbox_events"
        const val ACKNOWLEDGED_KEY = "acknowledged_event_ids"
        val UUID_PATTERN: Pattern = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE,
        )
    }
}
