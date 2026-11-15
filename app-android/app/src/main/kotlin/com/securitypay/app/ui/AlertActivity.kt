package com.securitypay.alerts.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.securitypay.alerts.Graph
import com.securitypay.alerts.R
import com.securitypay.alerts.service.AlertVoiceService
import com.securitypay.core.Alert

/** Full-screen alert shown over the lock screen when something critical happens. */
class AlertActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        val alertId = intent.getStringExtra(EXTRA_ALERT_ID)
        setContent {
            SecurityPayTheme {
                val alerts by Graph.alertStore.alerts.collectAsStateWithLifecycle()
                val alert = alerts.firstOrNull { it.alertId == alertId }
                AlertScreen(alert, onClose = { finish() })
            }
        }
    }

    companion object {
        const val EXTRA_ALERT_ID = "alert_id"

        fun intent(context: Context, alertId: String): Intent =
            Intent(context, AlertActivity::class.java).putExtra(EXTRA_ALERT_ID, alertId)
    }
}

@Composable
private fun AlertScreen(alert: Alert?, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val critical = alert?.isCritical != false
    val accent = if (critical) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(112.dp).background(accent.copy(alpha = 0.14f), CircleShape),
            ) {
                Icon(
                    Icons.Filled.Warning,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(56.dp),
                )
            }
            Text(
                if (critical) stringResource(R.string.alert_critical_banner) else stringResource(R.string.alert_banner),
                style = MaterialTheme.typography.labelLarge,
                color = accent,
            )
            Text(
                alert?.title ?: stringResource(R.string.alert_missing),
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag("alert_title"),
            )
            if (alert != null) {
                Text(
                    alert.message,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Text(
                    DateUtils.getRelativeTimeSpanString(alert.createdAt).toString(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (alert.ackedAt != null) {
                    val ackedAt = alert.ackedAt ?: 0L
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                        Text(
                            stringResource(R.string.alert_acked_at, DateUtils.getRelativeTimeSpanString(ackedAt).toString()),
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                if (alert.ackedAt == null) {
                    Button(
                        onClick = {
                            Graph.alerts.acknowledge(alert.alertId)
                            onClose()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = accent),
                        modifier = Modifier.fillMaxWidth().height(56.dp).testTag("alert_ack"),
                    ) { Text(stringResource(R.string.alert_ack)) }
                }
                if (alert.isCritical && alert.voiceRoom != null) {
                    OutlinedButton(
                        onClick = { AlertVoiceService.start(ctx, alert.alertId) },
                        modifier = Modifier.fillMaxWidth().height(52.dp).testTag("alert_listen"),
                    ) {
                        Icon(
                            androidx.compose.ui.res.painterResource(R.drawable.ic_mic),
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.alert_listen))
                    }
                }
            }
            TextButton(onClick = onClose, modifier = Modifier.testTag("alert_close")) {
                Text(stringResource(R.string.alert_close))
            }
            if (alert != null) {
                Text(
                    alert.source,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = FontWeight.Normal,
                )
            }
        }
    }
}
