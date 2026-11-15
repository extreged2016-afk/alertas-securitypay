package com.securitypay.alerts.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.securitypay.alerts.Graph
import com.securitypay.alerts.R
import com.securitypay.alerts.notify.Notifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Plays the siren with the ALARM audio stream and a wake lock, so a locked phone in
 * Doze still rings. It is a foreground service (mediaPlayback) started from FCM or
 * from the WebSocket service, both allowed to start it.
 */
class AlertAlarmService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focus: AudioFocusRequest? = null
    private var stopJob: Job? = null
    private var alertId: String? = null

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
        val id = intent?.getStringExtra(EXTRA_ALERT_ID)
        val priority = intent?.getStringExtra(EXTRA_PRIORITY) ?: "critical"
        val alert = id?.let { Graph.alertStore.get(it) }
        if (alert == null) {
            stopNow()
            return START_NOT_STICKY
        }
        if (alert.ackedAt != null) {
            stopNow()
            return START_NOT_STICKY
        }
        alertId = alert.alertId
        startForegroundSafely(Notifications.alarmOngoing(this, alert))
        playSiren(if (priority == "critical") 60_000L else 20_000L)
        stopJob?.cancel()
        stopJob = scope.launch {
            delay(if (priority == "critical") 60_000L else 20_000L)
            stopNow()
        }
        return START_NOT_STICKY
    }

    private fun startForegroundSafely(notification: android.app.Notification) {
        val type = if (Build.VERSION.SDK_INT >= 29) android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        try {
            ServiceCompat.startForeground(this, Notifications.ID_ALERT, notification, type)
        } catch (e: Exception) {
            Log.w(TAG, "startForeground(mediaPlayback) failed", e)
            stopNow()
        }
    }

    private fun playSiren(durationMs: Long) {
        stopAudio()
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SecurityPay:alarm").apply {
            setReferenceCounted(false)
            acquire(durationMs + 5_000)
        }
        val am = getSystemService(AudioManager::class.java)
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .build()
            .also { am.requestAudioFocus(it) }
        try {
            player = MediaPlayer.create(this, R.raw.alarm)?.apply {
                isLooping = true
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setVolume(1f, 1f)
                start()
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not play the alarm", e)
        }
        vibrator = if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        }
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 700, 250, 700, 250, 1000), 0))
    }

    private fun stopAudio() {
        runCatching { player?.stop(); player?.release() }
        player = null
        runCatching { vibrator?.cancel() }
        vibrator = null
        focus?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        focus = null
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }

    private fun stopNow() {
        stopJob?.cancel()
        stopAudio()
        Notifications.cancelAlert(this)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopAudio()
        scope.cancel()
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AlertAlarmService"
        const val ACTION_STOP = "com.securitypay.alerts.alarm.STOP"
        const val EXTRA_ALERT_ID = "alert_id"
        const val EXTRA_PRIORITY = "priority"

        @Volatile private var instance: AlertAlarmService? = null

        fun start(context: Context, alertId: String, priority: String) {
            val i = Intent(context, AlertAlarmService::class.java)
                .putExtra(EXTRA_ALERT_ID, alertId)
                .putExtra(EXTRA_PRIORITY, priority)
            try {
                ContextCompat.startForegroundService(context, i)
            } catch (e: Exception) {
                Log.w(TAG, "cannot start the alarm service", e)
            }
        }

        fun stop(context: Context) {
            val i = Intent(context, AlertAlarmService::class.java).setAction(ACTION_STOP)
            runCatching { context.startService(i) }
            instance?.stopNow()
        }
    }
}
