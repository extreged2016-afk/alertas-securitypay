package com.securitypay.alerts.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.securitypay.alerts.Graph
import com.securitypay.alerts.R
import com.securitypay.alerts.notify.Notifications
import com.securitypay.core.Alert
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * Critical alerts: join the LiveKit room created by the relay and play the voice
 * agent's explanation. If the room is unavailable (no LiveKit configured, worker
 * offline, no network) the phone speaks the alert with Android TTS after a short
 * grace period, so the user always hears what happened.
 */
class AlertVoiceService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var room: Room? = null
    private var audioSwitch: AudioSwitchHandler? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var eventsJob: Job? = null
    private var timeoutJob: Job? = null
    @Volatile private var spoken = false
    @Volatile private var closing = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale("es", "ES")
                ttsReady = true
            }
        }.apply {
            setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                override fun onDone(utteranceId: String?) {
                    // Local TTS finished and there is no remote voice agent: let go.
                    if (room == null) scope.launch { delay(1_200); stopNow() }
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = Unit
            })
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopNow()
            return START_NOT_STICKY
        }
        closing = false
        val id = intent?.getStringExtra(EXTRA_ALERT_ID)
        val alert = id?.let { Graph.alertStore.get(it) }
        if (alert == null || alert.ackedAt != null) {
            stopNow()
            return START_NOT_STICKY
        }
        startForegroundSafely()
        if (alert.voiceRoom == null) {
            speak(alert)
            return START_NOT_STICKY
        }
        connect(alert)
        return START_NOT_STICKY
    }

    private fun startForegroundSafely() {
        val type = if (Build.VERSION.SDK_INT >= 29) android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        try {
            ServiceCompat.startForeground(
                this,
                Notifications.ID_ALERT_VOICE,
                Notifications.alertService(this, getString(R.string.voice_connecting), true),
                type,
            )
        } catch (e: Exception) {
            Log.w(TAG, "startForeground(mediaPlayback) failed", e)
        }
    }

    private fun connect(alert: Alert) {
        // Never leave the user in silence: the room has a hard time limit.
        timeoutJob?.cancel()
        timeoutJob = scope.launch {
            delay(90_000)
            stopNow()
        }
        // If the voice worker is not there after a few seconds, the phone speaks.
        scope.launch {
            delay(9_000)
            if (!spoken && !closing) speak(alert)
        }
        scope.launch(Dispatchers.IO) {
            val info = runCatching { Graph.api()?.alertVoiceToken(alert.alertId) }.getOrNull()
            if (info == null) {
                withContext(Dispatchers.Main) { speak(alert) }
                return@launch
            }
            try {
                val sw = AudioSwitchHandler(applicationContext).apply {
                    preferredDeviceList = listOf(
                        AudioDevice.Speakerphone::class.java,
                        AudioDevice.BluetoothHeadset::class.java,
                        AudioDevice.WiredHeadset::class.java,
                        AudioDevice.Earpiece::class.java,
                    )
                }
                audioSwitch = sw
                val r = LiveKit.create(
                    appContext = applicationContext,
                    overrides = LiveKitOverrides(audioOptions = AudioOptions(audioHandler = sw)),
                )
                room = r
                eventsJob = scope.launch {
                    r.events.collect { e ->
                        when (e) {
                            is RoomEvent.TrackSubscribed -> {
                                spoken = true
                                Log.i(TAG, "voice agent audio subscribed")
                            }
                            is RoomEvent.Disconnected -> if (!closing) speakIfSilent(alert)
                            else -> Unit
                        }
                    }
                }
                r.connect(info.livekitUrl, info.livekitToken, ConnectOptions(audio = false))
                sw.availableAudioDevices.firstOrNull { it is AudioDevice.Speakerphone }?.let { sw.selectDevice(it) }
            } catch (e: Exception) {
                Log.w(TAG, "LiveKit voice failed, using local TTS", e)
                withContext(Dispatchers.Main) { speak(alert) }
            }
        }
    }

    private fun speakIfSilent(alert: Alert) {
        if (!spoken && !closing) speak(alert)
    }

    private fun speak(alert: Alert) {
        if (spoken && room != null) return
        val text = "${if (alert.isCritical) "Alerta crítica." else "Alerta."} ${alert.title}. ${alert.message}"
        Log.i(TAG, "speaking locally: ${alert.alertId}")
        val params = Bundle()
        if (ttsReady) {
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, "securitypay-${alert.alertId}")
        } else {
            // TTS engine still warming up: retry once.
            scope.launch {
                delay(800)
                if (ttsReady) {
                    tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, "securitypay-${alert.alertId}")
                } else {
                    delay(4_000)
                    if (room == null) stopNow()
                }
            }
        }
    }

    private fun stopNow() {
        closing = true
        timeoutJob?.cancel()
        eventsJob?.cancel()
        runCatching { room?.disconnect() }
        runCatching { room?.release() }
        room = null
        runCatching { tts?.stop() }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        closing = true
        eventsJob?.cancel()
        timeoutJob?.cancel()
        runCatching { room?.disconnect(); room?.release() }
        runCatching { tts?.shutdown() }
        tts = null
        scope.cancel()
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "AlertVoiceService"
        const val ACTION_STOP = "com.securitypay.alerts.voice.STOP"
        const val EXTRA_ALERT_ID = "alert_id"

        @Volatile private var instance: AlertVoiceService? = null

        fun start(context: Context, alertId: String) {
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, AlertVoiceService::class.java).putExtra(EXTRA_ALERT_ID, alertId),
                )
            } catch (e: Exception) {
                Log.w(TAG, "cannot start the voice service", e)
            }
        }

        fun stop(context: Context) {
            runCatching {
                context.startService(Intent(context, AlertVoiceService::class.java).setAction(ACTION_STOP))
            }
            instance?.stopNow()
        }
    }
}
