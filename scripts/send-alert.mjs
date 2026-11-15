#!/usr/bin/env node
// Envía una alerta al relay de Alert SecurityPay.
//
//   SECURITYPAY_RELAY_URL=https://alertas.midominio.com \
//   SECURITYPAY_API_KEY=ak_... \
//   node scripts/send-alert.mjs --title "Disco lleno" --message "Queda 3%" --priority critical
//
// Prioridades: low | normal | high | critical. Solo las críticas abren sala de voz.

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : true;
};

const relay = String(opt("relay", process.env.SECURITYPAY_RELAY_URL ?? "http://localhost:8080")).replace(/\/$/, "");
const apiKey = String(opt("api-key", process.env.SECURITYPAY_API_KEY ?? ""));
if (!apiKey) {
  console.error("Falta la API key: --api-key o SECURITYPAY_API_KEY");
  process.exit(1);
}

const body = {
  type: String(opt("type", "manual")),
  title: String(opt("title", "Alerta de Alert SecurityPay")),
  message: String(opt("message", "Prueba desde la línea de comandos.")),
  priority: String(opt("priority", "normal")),
  source: String(opt("source", "cli")),
};

const res = await fetch(`${relay}/v1/alerts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${text}`);
  process.exit(1);
}
const alert = JSON.parse(text);
console.log(`Alerta enviada: ${alert.alert_id} (${alert.priority})${alert.voice_room ? ` · voz: ${alert.voice_room}` : ""}`);
