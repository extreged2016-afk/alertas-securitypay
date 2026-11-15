package com.securitypay.alerts.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.securitypay.alerts.Graph
import com.securitypay.alerts.notify.Notifications
import com.securitypay.core.Event
import com.securitypay.core.RelayApi
import com.securitypay.core.RelaySocket
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Persistent WebSocket (`/ws/relay`) in a foreground service. This is what makes the
 * app an alert center while it is not on screen: FCM may be delayed or throttled,
 * the socket keeps the phone listening for outages in real time.
 *
 * Battery: the socket is event-driven (ping every 20 s), and the notification is
 * IMPORTANCE_LOW, so the cost is close to a push connection.
 */
class AlertService : Service() {
    private var socket: RelaySocket? = null
    @Volatile private var started = false
    private val prefs by lazy { getSharedPreferences("alert_service", MODE_PRIVATE) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopNow()
            return START_NOT_STICKY
        }
        startForegroundSafely()
        if (intent?.action == ACTION_RECONNECT) disconnect()
        connect()
        return START_STICKY
    }

    private fun startForegroundSafely() {
        // remoteMessaging (API 34+) keeps a live message relay without the 6h/24h
        // limit Android 15 puts on dataSync. Below 34 dataSync is the right type.
        val type = when {
            Build.VERSION.SDK_INT >= 34 -> android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
            Build.VERSION.SDK_INT >= 29 -> android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else -> 0
        }
        try {
            ServiceCompat.startForeground(
                this,
                Notifications.ID_ALERT_SERVICE,
                Notifications.alertService(this, getString(com.securitypay.alerts.R.string.alert_service_connecting), false),
                type,
            )
        } catch (e: Exception) {
            Log.w(TAG, "startForeground(dataSync) failed", e)
        }
    }

    private fun connect() {
        if (started) return
        val p = Graph.pairing.current ?: run { stopNow(); return }
        if (Graph.pairing.revoked.value) { stopNow(); return }
        val api = RelayApi(p.relayUrl, p.deviceJwt, userAgent = Graph.userAgent)
        val generation = Graph.messages.generation
        var created: RelaySocket? = null
        val s = RelaySocket(
            api,
            { prefs.getLong(KEY_SEQ, 0L) },
            object : RelaySocket.Listener {
                override fun onEvent(event: Event) {
                    if (generation != Graph.messages.generation) return
                    event.seq?.let { prefs.edit().putLong(KEY_SEQ, it).apply() }
                    when (event) {
                        is Event.AlertNew -> Graph.alerts.onAlert(event.toAlert(), fromPush = false)
                        is Event.AlertAck -> Graph.alerts.onAck(event.alertId, event.ackedAt, event.ackedBy)
                        else -> Unit
                    }
                }

                override fun onState(state: RelaySocket.State) {
                    if (socket !== created) return
                    stateFlow.value = state
                    val text = when (state) {
                        RelaySocket.State.CONNECTED -> getString(com.securitypay.alerts.R.string.alert_service_connected)
                        RelaySocket.State.CONNECTING -> getString(com.securitypay.alerts.R.string.alert_service_connecting)
                        RelaySocket.State.DISCONNECTED -> getString(com.securitypay.alerts.R.string.alert_service_disconnected)
                    }
                    runCatching {
                        getSystemService(android.app.NotificationManager::class.java).notify(
                            Notifications.ID_ALERT_SERVICE,
                            Notifications.alertService(this@AlertService, text, state == RelaySocket.State.CONNECTED),
                        )
                    }
                }

                override fun onUnauthorized() {
                    Log.w(TAG, "relay rejected the alert socket")
                    Graph.pairing.markRevoked()
                }

                override fun onWrongRelay(relayId: String) {
                    Log.w(TAG, "wrong relay: $relayId")
                }
            },
            expectedRelayId = p.relayId,
        )
        created = s
        socket = s
        started = true
        s.start()
    }

    private fun disconnect() {
        socket?.stop()
        socket = null
        started = false
    }

    private fun stopNow() {
        disconnect()
        stateFlow.value = RelaySocket.State.DISCONNECTED
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        disconnect()
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AlertService"
        private const val KEY_SEQ = "alert_ws_seq"
        const val ACTION_START = "com.securitypay.alerts.service.START"
        const val ACTION_STOP = "com.securitypay.alerts.service.STOP"
        const val ACTION_RECONNECT = "com.securitypay.alerts.service.RECONNECT"

        @Volatile private var instance: AlertService? = null
        private val stateFlow = MutableStateFlow(RelaySocket.State.DISCONNECTED)
        val state: StateFlow<RelaySocket.State> = stateFlow

        fun start(context: Context) {
            if (!Graph.settings.alertsEnabled) return
            if (Graph.pairing.current == null) return
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, AlertService::class.java).setAction(ACTION_START),
                )
            } catch (e: Exception) {
                Log.w(TAG, "cannot start the alert service", e)
            }
        }

        fun reconnect(context: Context) {
            if (!Graph.settings.alertsEnabled) return
            runCatching {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, AlertService::class.java).setAction(ACTION_RECONNECT),
                )
            }
        }

        fun stop(context: Context) {
            runCatching { context.startService(Intent(context, AlertService::class.java).setAction(ACTION_STOP)) }
            instance?.stopNow()
        }
    }
}
