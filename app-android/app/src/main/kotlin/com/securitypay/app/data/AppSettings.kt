package com.securitypay.alerts.data

import android.content.Context
import androidx.core.content.edit

/** User-tweakable behaviour. */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /**
     * Register calls with Android Telecom (headset buttons, watches, cars, system audio routing).
     * Can be turned off if a device's Telecom misbehaves; calls then use our own routing.
     */
    var useTelecom: Boolean
        get() = prefs.getBoolean(KEY_USE_TELECOM, true)
        set(v) = prefs.edit { putBoolean(KEY_USE_TELECOM, v) }

    /** Persistent WebSocket alert listener (foreground service). Unlimited: always on. */
    var alertsEnabled: Boolean
        get() = prefs.getBoolean(KEY_ALERTS_ENABLED, true)
        set(v) = prefs.edit { putBoolean(KEY_ALERTS_ENABLED, v) }

    /** Play the siren for high/critical alerts. */
    var alarmSound: Boolean
        get() = prefs.getBoolean(KEY_ALARM_SOUND, true)
        set(v) = prefs.edit { putBoolean(KEY_ALARM_SOUND, v) }

    /** Auto-join the LiveKit room and speak critical alerts. */
    var autoVoice: Boolean
        get() = prefs.getBoolean(KEY_AUTO_VOICE, true)
        set(v) = prefs.edit { putBoolean(KEY_AUTO_VOICE, v) }

    private companion object {
        const val KEY_USE_TELECOM = "use_telecom"
        const val KEY_ALERTS_ENABLED = "alerts_enabled"
        const val KEY_ALARM_SOUND = "alarm_sound"
        const val KEY_AUTO_VOICE = "auto_voice"
    }
}
