package com.securitypay.alerts.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.securitypay.core.Alert
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Persistent alert history (SQLite, no Room dependency) kept in sync with the relay. */
class AlertStore(context: Context) {
    private val helper = Helper(context.applicationContext)
    private val _alerts = MutableStateFlow<List<Alert>>(emptyList())
    val alerts: StateFlow<List<Alert>> = _alerts

    init {
        _alerts.value = readAll()
    }

    /** Returns true when this alert was not in the local history yet. */
    @Synchronized
    fun upsert(alert: Alert): Boolean {
        val existing = find(alert.alertId)
        val merged = if (existing?.ackedAt != null && alert.ackedAt == null) {
            alert.copy(ackedAt = existing.ackedAt, ackedBy = existing.ackedBy)
        } else {
            alert
        }
        val values = ContentValues().apply {
            put("alert_id", merged.alertId)
            put("type", merged.type)
            put("title", merged.title)
            put("message", merged.message)
            put("priority", merged.priority)
            put("source", merged.source)
            put("data_json", merged.data?.toString())
            put("voice_room", merged.voiceRoom)
            put("voice_url", merged.voiceUrl)
            put("created_at", merged.createdAt)
            put("acked_at", merged.ackedAt)
            put("acked_by", merged.ackedBy)
        }
        helper.writableDatabase.insertWithOnConflict("alerts", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        prune()
        _alerts.value = readAll()
        return existing == null
    }

    @Synchronized
    fun upsertAll(list: List<Alert>) {
        for (alert in list) {
            val values = ContentValues().apply {
                put("alert_id", alert.alertId)
                put("type", alert.type)
                put("title", alert.title)
                put("message", alert.message)
                put("priority", alert.priority)
                put("source", alert.source)
                put("data_json", alert.data?.toString())
                put("voice_room", alert.voiceRoom)
                put("voice_url", alert.voiceUrl)
                put("created_at", alert.createdAt)
                put("acked_at", alert.ackedAt)
                put("acked_by", alert.ackedBy)
            }
            helper.writableDatabase.insertWithOnConflict("alerts", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        }
        prune()
        _alerts.value = readAll()
    }

    @Synchronized
    fun markAcked(alertId: String, at: Long, by: String?) {
        val values = ContentValues().apply {
            put("acked_at", at)
            put("acked_by", by)
        }
        helper.writableDatabase.update("alerts", values, "alert_id = ?", arrayOf(alertId))
        _alerts.value = readAll()
    }

    @Synchronized
    fun clear() {
        helper.writableDatabase.delete("alerts", null, null)
        _alerts.value = emptyList()
    }

    fun unacked(): List<Alert> = _alerts.value.filter { it.ackedAt == null }

    fun get(alertId: String): Alert? = _alerts.value.firstOrNull { it.alertId == alertId } ?: find(alertId)

    private fun prune() {
        // The panel keeps everything on the relay; the phone keeps the last 1000.
        helper.writableDatabase.execSQL(
            "DELETE FROM alerts WHERE alert_id NOT IN (SELECT alert_id FROM alerts ORDER BY created_at DESC LIMIT 1000)",
        )
    }

    private fun find(alertId: String): Alert? = helper.readableDatabase
        .query("alerts", null, "alert_id = ?", arrayOf(alertId), null, null, null)
        .use { c -> if (c.moveToFirst()) c.toAlert() else null }

    private fun readAll(): List<Alert> = helper.readableDatabase
        .query("alerts", null, null, null, null, null, "created_at DESC")
        .use { c ->
            buildList {
                while (c.moveToNext()) add(c.toAlert())
            }
        }

    private fun Cursor.toAlert(): Alert = Alert(
        alertId = getString(getColumnIndexOrThrow("alert_id")),
        type = getString(getColumnIndexOrThrow("type")),
        title = getString(getColumnIndexOrThrow("title")),
        message = getString(getColumnIndexOrThrow("message")),
        priority = getString(getColumnIndexOrThrow("priority")),
        source = getString(getColumnIndexOrThrow("source")),
        data = getStringOrNull("data_json")?.let { runCatching { Json.parseToJsonElement(it) as JsonObject }.getOrNull() },
        voiceRoom = getStringOrNull("voice_room"),
        voiceUrl = getStringOrNull("voice_url"),
        createdAt = getLong(getColumnIndexOrThrow("created_at")),
        ackedAt = getLongOrNull("acked_at"),
        ackedBy = getStringOrNull("acked_by"),
    )

    private fun Cursor.getStringOrNull(name: String): String? {
        val i = getColumnIndexOrThrow(name)
        return if (isNull(i)) null else getString(i)
    }

    private fun Cursor.getLongOrNull(name: String): Long? {
        val i = getColumnIndexOrThrow(name)
        return if (isNull(i)) null else getLong(i)
    }

    private class Helper(context: Context) : SQLiteOpenHelper(context, "securitypay_alerts.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE alerts (
                    alert_id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    source TEXT NOT NULL,
                    data_json TEXT,
                    voice_room TEXT,
                    voice_url TEXT,
                    created_at INTEGER NOT NULL,
                    acked_at INTEGER,
                    acked_by TEXT
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE INDEX alerts_created ON alerts(created_at DESC)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }
}
