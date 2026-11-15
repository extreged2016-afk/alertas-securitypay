package com.securitypay.alerts.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.securitypay.alerts.Graph

/** Decline / hang up from the call notification (no UI needed for either). */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_DECLINE -> Graph.calls.decline()
            ACTION_HANG_UP -> Graph.calls.hangUp()
        }
    }

    companion object {
        const val ACTION_DECLINE = "com.securitypay.alerts.call.DECLINE"
        const val ACTION_HANG_UP = "com.securitypay.alerts.call.HANG_UP"
    }
}
