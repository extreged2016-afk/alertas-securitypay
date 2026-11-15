package com.securitypay.alerts

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.securitypay.alerts.call.CallNotifications
import com.securitypay.alerts.notify.Notifications

class SecurityPayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
        Notifications.createChannels(this)
        CallNotifications.createChannels(this)
        // Firebase must be ready before FirebaseMessagingService delivers a push.
        Graph.pairing.current?.let { Graph.push.initFirebase(it.pushConfig) }
        // The persistent /ws/relay listener makes alerts real-time (unlimited, no polling).
        com.securitypay.alerts.service.AlertService.start(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(Graph.connection)
    }
}
