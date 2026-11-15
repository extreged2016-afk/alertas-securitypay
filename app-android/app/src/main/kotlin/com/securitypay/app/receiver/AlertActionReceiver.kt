package com.securitypay.alerts.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.securitypay.alerts.Graph
import com.securitypay.alerts.service.AlertAlarmService
import com.securitypay.alerts.service.AlertVoiceService

/** Notification buttons of an alert: acknowledge it or just stop the siren. */
class AlertActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val alertId = intent.getStringExtra(EXTRA_ALERT_ID) ?: return
        when (intent.action) {
            ACTION_ACK -> Graph.alerts.acknowledge(alertId)
            ACTION_SILENCE -> {
                AlertAlarmService.stop(context)
                AlertVoiceService.stop(context)
            }
        }
    }

    companion object {
        const val ACTION_ACK = "com.securitypay.alerts.ACK"
        const val ACTION_SILENCE = "com.securitypay.alerts.SILENCE"
        const val EXTRA_ALERT_ID = "alert_id"
    }
}
