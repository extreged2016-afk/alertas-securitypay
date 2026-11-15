package com.securitypay.alerts.ui

import android.text.format.DateUtils
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.securitypay.alerts.Graph
import com.securitypay.alerts.R
import com.securitypay.alerts.service.AlertService
import com.securitypay.core.Alert
import com.securitypay.core.RelaySocket

private enum class AlertFilter { ALL, CRITICAL, UNACKED }

/** Alert center: live channel status, test alerts and the full history. */
@Composable
fun AlertsScreen() {
    val alerts by Graph.alertStore.alerts.collectAsStateWithLifecycle()
    val channel by AlertService.state.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf(AlertFilter.ALL) }
    var message by remember { mutableStateOf<String?>(null) }

    val shown = when (filter) {
        AlertFilter.ALL -> alerts
        AlertFilter.CRITICAL -> alerts.filter { it.isCritical }
        AlertFilter.UNACKED -> alerts.filter { it.ackedAt == null }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.tab_alerts), style = MaterialTheme.typography.headlineMedium)
                Text(
                    stringResource(R.string.alerts_subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item { ChannelCard(channel) }
        item {
            BrandCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.alerts_test_title), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.alerts_test_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        TestButton(R.string.alert_priority_normal, "test_normal", Modifier.weight(1f)) {
                            Graph.alerts.sendTest(Alert.PRIORITY_NORMAL) { r ->
                                message = r.exceptionOrNull()?.message
                            }
                        }
                        TestButton(R.string.alert_priority_high, "test_high", Modifier.weight(1f)) {
                            Graph.alerts.sendTest(Alert.PRIORITY_HIGH) { r ->
                                message = r.exceptionOrNull()?.message
                            }
                        }
                        TestButton(R.string.alert_priority_critical, "test_critical", Modifier.weight(1f)) {
                            Graph.alerts.sendTest(Alert.PRIORITY_CRITICAL) { r ->
                                message = r.exceptionOrNull()?.message
                            }
                        }
                    }
                    message?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(
                    selected = filter == AlertFilter.ALL,
                    onClick = { filter = AlertFilter.ALL },
                    label = { Text(stringResource(R.string.alerts_filter_all)) },
                    modifier = Modifier.testTag("filter_all"),
                )
                FilterChip(
                    selected = filter == AlertFilter.CRITICAL,
                    onClick = { filter = AlertFilter.CRITICAL },
                    label = { Text(stringResource(R.string.alerts_filter_critical)) },
                    modifier = Modifier.testTag("filter_critical"),
                )
                FilterChip(
                    selected = filter == AlertFilter.UNACKED,
                    onClick = { filter = AlertFilter.UNACKED },
                    label = { Text(stringResource(R.string.alerts_filter_unacked)) },
                    modifier = Modifier.testTag("filter_unacked"),
                )
            }
        }
        if (shown.isEmpty()) {
            item {
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(stringResource(R.string.alerts_empty_title), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.alerts_empty_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            items(shown, key = { it.alertId }) { alert ->
                AlertRow(alert, onAck = { Graph.alerts.acknowledge(alert.alertId) })
            }
            item {
                TextButton(
                    onClick = {
                        Graph.alerts.clearHistory()
                        message = null
                    },
                    modifier = Modifier.fillMaxWidth().testTag("clear_alerts"),
                ) { Text(stringResource(R.string.alerts_clear)) }
            }
        }
        item { Spacer(Modifier.height(12.dp)) }
    }
}

@Composable
private fun TestButton(label: Int, tag: String, modifier: Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.testTag(tag)) {
        Text(stringResource(label), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun ChannelCard(state: RelaySocket.State) {
    val colors = LocalStatusColors.current
    val (text, color) = when (state) {
        RelaySocket.State.CONNECTED -> stringResource(R.string.alert_service_connected) to colors.ok
        RelaySocket.State.CONNECTING -> stringResource(R.string.alert_service_connecting) to colors.warn
        RelaySocket.State.DISCONNECTED -> stringResource(R.string.alert_service_disconnected) to colors.bad
    }
    BrandCard {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(44.dp).background(color.copy(alpha = 0.15f), CircleShape),
            ) {
                Icon(Icons.Filled.Notifications, null, tint = color, modifier = Modifier.size(22.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.alert_service_title), style = MaterialTheme.typography.titleSmall)
                Text(text, style = MaterialTheme.typography.bodyMedium, color = color, modifier = Modifier.testTag("alert_channel_state"))
                Text(
                    stringResource(R.string.alerts_channel_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun AlertRow(alert: Alert, onAck: () -> Unit) {
    val accent = when (alert.priority) {
        Alert.PRIORITY_CRITICAL -> MaterialTheme.colorScheme.error
        Alert.PRIORITY_HIGH -> LocalStatusColors.current.warn
        else -> MaterialTheme.colorScheme.primary
    }
    val unacked = alert.ackedAt == null
    BrandCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (alert.isCritical) Icons.Filled.Warning else Icons.Filled.Notifications,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    stringResource(priorityLabel(alert.priority)).uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = accent,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    DateUtils.getRelativeTimeSpanString(alert.createdAt).toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(alert.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                alert.message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.extraSmall) {
                    Text(
                        alert.source,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                if (unacked) {
                    Button(onClick = onAck, modifier = Modifier.testTag("ack_${alert.alertId}")) {
                        Text(stringResource(R.string.alert_ack))
                    }
                } else {
                    Text(
                        stringResource(R.string.alert_acked),
                        style = MaterialTheme.typography.labelMedium,
                        color = LocalStatusColors.current.ok,
                    )
                }
            }
        }
    }
}

private fun priorityLabel(priority: String): Int = when (priority) {
    Alert.PRIORITY_CRITICAL -> R.string.alert_priority_critical
    Alert.PRIORITY_HIGH -> R.string.alert_priority_high
    Alert.PRIORITY_LOW -> R.string.alert_priority_low
    else -> R.string.alert_priority_normal
}
