package com.securitypay.alerts.alerts

import android.content.Context
import android.util.Log
import com.securitypay.alerts.Graph
import com.securitypay.alerts.data.AlertStore
import com.securitypay.alerts.notify.Notifications
import com.securitypay.alerts.service.AlertAlarmService
import com.securitypay.alerts.service.AlertVoiceService
import com.securitypay.core.Alert
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * The single entry point for alerts, whether they arrive by FCM, the WebSocket or
 * a manual test. Deduplicates by alert id so a push and the socket can both deliver
 * the same alert without ringing twice.
 */
class AlertManager(
    private val context: Context,
    private val store: AlertStore,
) {
    private val _lastAlert = MutableStateFlow<Alert?>(null)
    val lastAlert: StateFlow<Alert?> = _lastAlert

    /** Returns true if this alert was new (and therefore rang). */
    fun onAlert(alert: Alert, fromPush: Boolean): Boolean {
        val isNew = store.upsert(alert)
        if (!isNew) return false
        _lastAlert.value = alert
        Notifications.showAlert(context, alert)
        if (alert.needsAlarm && Graph.settings.alarmSound) AlertAlarmService.start(context, alert.alertId, alert.priority)
        if (alert.needsVoice && Graph.settings.autoVoice) AlertVoiceService.start(context, alert.alertId)
        Log.i(TAG, "alert ${alert.alertId} ${alert.priority} via ${if (fromPush) "push" else "socket"}")
        return true
    }

    fun onAck(alertId: String, at: Long, by: String?) {
        store.markAcked(alertId, at, by)
        Notifications.cancelAlert(context)
        AlertAlarmService.stop(context)
        AlertVoiceService.stop(context)
    }

    /** Acknowledges on the relay and locally. Safe to call from the UI. */
    fun acknowledge(alertId: String) {
        val at = System.currentTimeMillis()
        onAck(alertId, at, "user")
        Graph.appScope.launch(Dispatchers.IO) {
            runCatching { Graph.api()?.ackAlert(alertId) }
                .onSuccess { updated -> updated?.let(store::upsert) }
                .onFailure { Log.w(TAG, "ack failed", it) }
        }
    }

    fun clearHistory() {
        store.clear()
        Notifications.cancelAlert(context)
        AlertAlarmService.stop(context)
    }

    /** Pulls the relay history (and pending voice rooms) after pairing or app start. */
    fun sync() {
        Graph.appScope.launch(Dispatchers.IO) {
            runCatching { Graph.api()?.listAlerts() }
                .onSuccess { page ->
                    if (page != null) {
                        store.upsertAll(page.alerts)
                        // If the app was closed when a critical alert arrived, offer its voice room now.
                        page.alerts.firstOrNull { it.isCritical && it.ackedAt == null && it.voiceRoom != null }?.let {
                            AlertVoiceService.start(context, it.alertId)
                        }
                    }
                }
                .onFailure { Log.w(TAG, "alert sync failed", it) }
        }
    }

    fun sendTest(priority: String, onResult: (Result<Alert>) -> Unit) {
        Graph.appScope.launch(Dispatchers.IO) {
            val result = runCatching {
                val api = Graph.api() ?: error("not paired")
                api.createAlert(
                    type = "test",
                    title = "Prueba de Alert SecurityPay",
                    message = "Esta es una alerta de prueba de tu centro de alertas.",
                    priority = priority,
                )
            }
            result.onSuccess { onAlert(it, fromPush = false) }
            kotlinx.coroutines.withContext(Dispatchers.Main) { onResult(result) }
        }
    }

    private companion object {
        const val TAG = "AlertManager"
    }
}
