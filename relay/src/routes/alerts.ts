import type { FastifyInstance } from "fastify";
import type { Principal } from "../auth.js";
import { type Ctx, principal, requireAuth } from "../context.js";
import { ApiError, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type { EventDraft, Schemas } from "../protocol.js";

type Alert = Schemas["Alert"];
type AlertPriority = Schemas["AlertPriority"];

interface AlertRow {
  alert_id: string;
  type: string;
  title: string;
  message: string;
  priority: AlertPriority;
  source: string;
  data: string | null;
  voice_room: string | null;
  tts_text: string | null;
  created_at: number;
  acked_at: number | null;
  acked_by: "agent" | "user" | null;
}

const PRIORITIES: ReadonlySet<string> = new Set(["low", "normal", "high", "critical"]);

export function alertFromRow(r: AlertRow): Alert {
  return {
    alert_id: r.alert_id,
    type: r.type,
    title: r.title,
    message: r.message,
    priority: r.priority,
    source: r.source,
    ...(r.data ? { data: JSON.parse(r.data) as Record<string, unknown> } : {}),
    ...(r.voice_room ? { voice_room: r.voice_room } : {}),
    created_at: r.created_at,
    ...(r.acked_at ? { acked_at: r.acked_at } : {}),
    ...(r.acked_by ? { acked_by: r.acked_by } : {}),
  };
}

function getRow(ctx: Ctx, alertId: string): AlertRow {
  const row = ctx.db.prepare("SELECT * FROM alerts WHERE alert_id = ?").get(alertId) as AlertRow | undefined;
  if (!row) throw notFound("Alert");
  return row;
}

/** LiveKit room of an alert; the app joins it to hear the spoken announcement. */
export const alertRoomName = (alertId: string) => `alert-${alertId}`;

function voiceUrl(ctx: Ctx): string | undefined {
  return ctx.cfg.livekit?.publicUrl;
}

function emitNew(ctx: Ctx, row: AlertRow): void {
  const draft = {
    type: "alert.new",
    alert_id: row.alert_id,
    alert_type: row.type,
    title: row.title,
    message: row.message,
    priority: row.priority,
    source: row.source,
    created_at: row.created_at,
    ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}),
    ...(row.voice_room ? { voice_room: row.voice_room } : {}),
    ...(row.voice_room && voiceUrl(ctx) ? { voice_url: voiceUrl(ctx)! } : {}),
  } as EventDraft;
  ctx.events.emit(draft);
}

/** Creates the LiveKit room when voice is enabled and this alert is critical. */
async function prepareVoice(ctx: Ctx, alertId: string, priority: AlertPriority, wanted: boolean): Promise<string | undefined> {
  if (!wanted || priority !== "critical" || !ctx.livekit) return undefined;
  const room = alertRoomName(alertId);
  try {
    await ctx.livekit.createRoom(room, 120);
  } catch (err) {
    // Already exists (the voice worker may have created it) is fine; a real failure
    // still leaves the alert useful: the phone falls back to local TTS.
    ctx.log.warn({ err, room }, "alert voice room was not created");
  }
  return room;
}

export function alertRoutes(app: FastifyInstance, ctx: Ctx): void {
  const auth = requireAuth(ctx, "agent", "device");

  app.post<{ Body: Schemas["CreateAlertRequest"] }>(
    "/v1/alerts",
    {
      preHandler: auth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "message"],
          properties: {
            type: { type: "string", minLength: 1, maxLength: 60 },
            title: { type: "string", minLength: 1, maxLength: 200 },
            message: { type: "string", minLength: 1, maxLength: 4000 },
            priority: { type: "string", enum: ["low", "normal", "high", "critical"], default: "normal" },
            source: { type: "string", minLength: 1, maxLength: 120 },
            data: { type: "object", additionalProperties: true },
            voice: { type: "boolean", default: true },
            tts_text: { type: "string", maxLength: 1200 },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const p = principal(req);
      const priority = (b.priority ?? "normal") as AlertPriority;
      if (!PRIORITIES.has(priority)) throw new ApiError(400, "invalid_request", "Invalid priority");
      const alertId = newId("alert");
      const now = Date.now();
      const source = b.source?.trim() || (p.kind === "agent" ? ctx.cfg.agentName : "securitypay-app");
      const room = await prepareVoice(ctx, alertId, priority, b.voice !== false);
      const tts = (b.tts_text?.trim() || `${b.title}. ${b.message}`).slice(0, 1200);
      ctx.db
        .prepare(
          `INSERT INTO alerts (alert_id, type, title, message, priority, source, data, voice_room, tts_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          alertId,
          b.type.slice(0, 60),
          b.title.slice(0, 200),
          b.message.slice(0, 4000),
          priority,
          source.slice(0, 120),
          b.data ? JSON.stringify(b.data).slice(0, 8000) : null,
          room ?? null,
          tts,
          now,
        );
      const row = getRow(ctx, alertId);
      emitNew(ctx, row);
      req.log.info({ alert: alertId, priority, source }, "alert created");
      return reply.code(201).send(alertFromRow(row));
    },
  );

  app.get<{ Querystring: { limit?: number; priority?: AlertPriority } }>(
    "/v1/alerts",
    {
      preHandler: auth,
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 100;
      const rows = req.query.priority
        ? (ctx.db
            .prepare("SELECT * FROM alerts WHERE priority = ? ORDER BY created_at DESC LIMIT ?")
            .all(req.query.priority, limit) as unknown as AlertRow[])
        : (ctx.db.prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as AlertRow[]);
      return { alerts: rows.map(alertFromRow) };
    },
  );

  app.get<{ Params: { alert_id: string } }>("/v1/alerts/:alert_id", { preHandler: auth }, async (req) =>
    alertFromRow(getRow(ctx, req.params.alert_id)),
  );

  app.post<{ Params: { alert_id: string } }>("/v1/alerts/:alert_id/ack", { preHandler: auth }, async (req) => {
    const p = principal(req);
    const row = getRow(ctx, req.params.alert_id);
    const now = Date.now();
    const by: "agent" | "user" = p.kind === "agent" ? "agent" : "user";
    if (!row.acked_at) {
      ctx.db.prepare("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE alert_id = ?").run(now, by, row.alert_id);
      ctx.events.emit({
        type: "alert.ack",
        alert_id: row.alert_id,
        acked_at: now,
        acked_by: by,
      } as EventDraft);
    }
    return alertFromRow(getRow(ctx, row.alert_id));
  });

  app.post<{ Params: { alert_id: string } }>(
    "/v1/alerts/:alert_id/voice-token",
    { preHandler: auth },
    async (req) => {
      const p = principal(req);
      const row = getRow(ctx, req.params.alert_id);
      if (!ctx.livekit) throw new ApiError(409, "invalid_state", "LiveKit is not configured on this relay");
      const room = row.voice_room ?? alertRoomName(row.alert_id);
      try {
        await ctx.livekit.createRoom(room, 120);
      } catch {
        // Already exists is the normal case.
      }
      if (!row.voice_room) {
        ctx.db.prepare("UPDATE alerts SET voice_room = ? WHERE alert_id = ?").run(room, row.alert_id);
      }
      const canPublish = p.kind === "agent";
      const identity = p.kind === "agent" ? "voice-agent" : `device_${p.deviceId}`;
      const name = p.kind === "agent" ? "Agente de voz" : "SecurityPay";
      return ctx.livekit.join(room, identity, name, canPublish);
    },
  );
}
