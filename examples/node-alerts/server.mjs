// Backend mínimo (Node 22+, sin dependencias) que reenvía alertas al relay de
// Alert SecurityPay. Despliégalo en Render/Railway/Fly o ejecútalo en local:
//
//   RELAY_URL=https://alertas.midominio.com \
//   RELAY_API_KEY=ak_... \
//   ALERT_WEBHOOK_SECRET=super-secreto \
//   node server.mjs
//
//   curl -X POST http://localhost:3000/alert \
//     -H "authorization: Bearer super-secreto" \
//     -H "content-type: application/json" \
//     -d '{"title":"Disco lleno","message":"Queda un 3%","priority":"critical"}'

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3000);
const RELAY_URL = (process.env.RELAY_URL ?? "").replace(/\/$/, "");
const RELAY_API_KEY = process.env.RELAY_API_KEY ?? "";
const SECRET = process.env.ALERT_WEBHOOK_SECRET ?? "";

if (!RELAY_URL || !RELAY_API_KEY) {
  console.error("Faltan RELAY_URL o RELAY_API_KEY");
  process.exit(1);
}

const LIMITS = { title: 200, message: 4000, type: 60, source: 120 };

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("cuerpo demasiado grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function sendAlert(input) {
  const alert = {
    type: String(input.type ?? "backend").slice(0, LIMITS.type),
    title: String(input.title ?? "").slice(0, LIMITS.title),
    message: String(input.message ?? "").slice(0, LIMITS.message),
    priority: ["low", "normal", "high", "critical"].includes(input.priority) ? input.priority : "normal",
    source: String(input.source ?? "node-backend").slice(0, LIMITS.source),
    voice: input.voice !== false,
  };
  if (!alert.title || !alert.message) throw new Error("title y message son obligatorios");
  if (input.data && typeof input.data === "object") alert.data = input.data;

  const res = await fetch(`${RELAY_URL}/v1/alerts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${RELAY_API_KEY}` },
    body: JSON.stringify(alert),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`relay ${res.status}: ${text}`);
  return JSON.parse(text);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/alert") return json(res, 404, { error: "not_found" });

  if (SECRET) {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });
  }

  try {
    const alert = await sendAlert(await readJson(req));
    return json(res, 201, { ok: true, alert_id: alert.alert_id, voice_room: alert.voice_room ?? null });
  } catch (err) {
    console.error(err);
    return json(res, 400, { error: String(err.message ?? err) });
  }
});

server.listen(PORT, () => console.log(`escuchando en :${PORT} → ${RELAY_URL}`));
