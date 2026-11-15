package com.securitypay.alerts.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.securitypay.alerts.Graph
import com.securitypay.alerts.R
import com.securitypay.alerts.receiver.AlertActionReceiver
import com.securitypay.alerts.ui.AlertActivity
import com.securitypay.alerts.ui.MainActivity
import com.securitypay.core.Alert
import com.securitypay.core.Message

object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_ALERTS_CRITICAL = "alerts_critical"
    const val CHANNEL_ALERTS = "alerts"
    const val CHANNEL_ALERT_SERVICE = "alert_service"
    const val ID_MESSAGES = 1001
    const val ID_TEST = 1002
    const val ID_REPLY_FAILED = 1003
    const val ID_ALERT = 1100
    const val ID_ALERT_SERVICE = 1101
    const val ID_ALERT_VOICE = 1102
    const val KEY_REPLY = "reply_text"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, context.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH),
        )
        val critical = NotificationChannel(
            CHANNEL_ALERTS_CRITICAL,
            context.getString(R.string.channel_alerts_critical),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_alerts_critical_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 600, 250, 600, 250, 900)
            setBypassDnd(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setSound(null, null)
        }
        val alerts = NotificationChannel(
            CHANNEL_ALERTS,
            context.getString(R.string.channel_alerts),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_alerts_desc)
            enableVibration(true)
        }
        val service = NotificationChannel(
            CHANNEL_ALERT_SERVICE,
            context.getString(R.string.channel_alert_service),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = context.getString(R.string.channel_alert_service_desc) }
        nm.createNotificationChannels(listOf(critical, alerts, service))
    }

    /** Visible, full-screen alert. The alarm audio is played by AlertAlarmService. */
    @SuppressLint("MissingPermission")
    fun showAlert(context: Context, alert: Alert) {
        if (!canNotify(context)) return
        val critical = alert.isCritical
        val channel = if (critical) CHANNEL_ALERTS_CRITICAL else CHANNEL_ALERTS
        val open = PendingIntent.getActivity(
            context,
            alert.alertId.hashCode(),
            AlertActivity.intent(context, alert.alertId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val ack = PendingIntent.getBroadcast(
            context,
            alert.alertId.hashCode() + 7,
            Intent(context, AlertActionReceiver::class.java)
                .setAction(AlertActionReceiver.ACTION_ACK)
                .putExtra(AlertActionReceiver.EXTRA_ALERT_ID, alert.alertId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val silence = PendingIntent.getBroadcast(
            context,
            alert.alertId.hashCode() + 8,
            Intent(context, AlertActionReceiver::class.java)
                .setAction(AlertActionReceiver.ACTION_SILENCE)
                .putExtra(AlertActionReceiver.EXTRA_ALERT_ID, alert.alertId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = if (critical) "🚨 CRÍTICA · ${alert.title}" else alert.title
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(alert.message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.message))
            .setCategory(if (critical) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setFullScreenIntent(open, critical)
            .setAutoCancel(false)
            .setOngoing(true)
            .setSound(null)
            .setVibrate(if (critical) longArrayOf(0, 600, 250, 600, 250, 900) else longArrayOf(0, 250, 180, 250))
            .addAction(R.drawable.ic_notification, context.getString(R.string.alert_ack), ack)
            .addAction(R.drawable.ic_call_end, context.getString(R.string.alert_silence), silence)
            .build()
        NotificationManagerCompat.from(context).notify(ID_ALERT, n)
    }

    fun cancelAlert(context: Context) {
        NotificationManagerCompat.from(context).cancel(ID_ALERT)
    }

    /** Foreground notification while the siren plays (same id as the alert). */
    @SuppressLint("MissingPermission")
    fun alarmOngoing(context: Context, alert: Alert): android.app.Notification {
        val open = PendingIntent.getActivity(
            context,
            alert.alertId.hashCode(),
            AlertActivity.intent(context, alert.alertId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val ack = PendingIntent.getBroadcast(
            context,
            alert.alertId.hashCode() + 7,
            Intent(context, AlertActionReceiver::class.java)
                .setAction(AlertActionReceiver.ACTION_ACK)
                .putExtra(AlertActionReceiver.EXTRA_ALERT_ID, alert.alertId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ALERTS_CRITICAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("🚨 ${alert.title}")
            .setContentText(alert.message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.message))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSound(null)
            .addAction(R.drawable.ic_notification, context.getString(R.string.alert_ack), ack)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    @SuppressLint("MissingPermission")
    fun alertService(context: Context, text: String, connected: Boolean): android.app.Notification {
        val open = PendingIntent.getActivity(
            context,
            9,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ALERT_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.alert_service_title))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun mutableFlag() = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0

    fun openMessagesIntent(context: Context): PendingIntent {
        val i = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_MESSAGES)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun replyAction(context: Context): NotificationCompat.Action {
        val intent = Intent(context, ReplyReceiver::class.java)
        val pi = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag())
        val input = RemoteInput.Builder(KEY_REPLY).setLabel(context.getString(R.string.reply)).build()
        return NotificationCompat.Action.Builder(R.drawable.ic_send, context.getString(R.string.reply), pi)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
    }

    private fun agentPerson(name: String) = Person.Builder().setName(name).setKey("agent").build()

    /**
     * Shows (or updates) the conversation notification with the agent's unread
     * messages, plus an optional reply the user just sent from the notification.
     */
    @SuppressLint("MissingPermission")
    fun showMessages(
        context: Context,
        agentName: String,
        agentMessages: List<Message> = Graph.messages.unreadFromAgent(),
        sentReply: String? = null,
    ) {
        if (!canNotify(context)) return
        val unread = agentMessages.takeLast(6)
        if (unread.isEmpty() && sentReply == null) return
        val me = Person.Builder().setName(context.getString(R.string.you)).build()
        val agent = agentPerson(agentName)
        val style = NotificationCompat.MessagingStyle(me)
        unread.forEach { style.addMessage(it.text, it.createdAt, agent) }
        if (sentReply != null) style.addMessage(sentReply, System.currentTimeMillis(), null as Person?)

        val n = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openMessagesIntent(context))
            .setAutoCancel(true)
            .setOnlyAlertOnce(sentReply != null)
            .addAction(replyAction(context))
            .build()
        NotificationManagerCompat.from(context).notify(ID_MESSAGES, n)
    }

    @SuppressLint("MissingPermission")
    fun showReplyFailed(context: Context, text: String, error: String) {
        if (!canNotify(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.reply_failed_title))
            .setContentText("$text — $error")
            .setStyle(NotificationCompat.BigTextStyle().bigText("$text\n\n$error"))
            .setContentIntent(openMessagesIntent(context))
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(ID_REPLY_FAILED, n)
    }

    @SuppressLint("MissingPermission")
    fun showTest(context: Context) {
        if (!canNotify(context)) return
        val name = Graph.pairing.current?.agentName ?: context.getString(R.string.app_name)
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName(context.getString(R.string.you)).build())
            .addMessage(context.getString(R.string.test_notification_text), System.currentTimeMillis(), agentPerson(name))
        val n = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(ID_TEST, n)
    }

    fun cancelMessages(context: Context) {
        NotificationManagerCompat.from(context).cancel(ID_MESSAGES)
    }
}
