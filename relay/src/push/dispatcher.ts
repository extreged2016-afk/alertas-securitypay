import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/database.js";
import type { Event } from "../protocol.js";
import type { PushPayload, PushProvider } from "./push-provider.js";

/** FCM data payloads are capped at 4096 bytes; leave room for the other keys. */
const MAX_EVENT_BYTES = 3000;
const MESSAGE_TTL_S = 28 * 24 * 3600;
/** Call state changes only matter while a phone may still be ringing or on the call. */
const CALL_UPDATE_TTL_S = 30;
/** "Someone is on the call, you can join": long enough for a phone that was offline; the app re-checks the call. */
const CALL_JOINABLE_TTL_S = 3600;

/** Just enough of a call for push routing; `device_ids` = the phones a targeted call rings. */
export type CallLookup = (callId: string) => Promise<{ direction: string; device_ids?: string[] } | undefined>;

export function signEvent(pushSecret: string, eventJson: string): string {
  return createHmac("sha256", Buffer.from(pushSecret, "base64url")).update(eventJson, "utf8").digest("base64url");
}

export function buildPayload(relayId: string, pushSecret: string, event: Event): PushPayload {
  let json = JSON.stringify(event);
  if (event.type === "msg.new" || event.type === "alert.new") {
    const field = event.type === "msg.new" ? "text" : "message";
    let text = (event as unknown as Record<string, string>)[field] ?? "";
    while (Buffer.byteLength(json) > MAX_EVENT_BYTES && text.length > 0) {
      const overflow = Buffer.byteLength(json) - MAX_EVENT_BYTES;
      // Cut by code points so we never split a surrogate pair.
      const chars = Array.from(text);
      text = chars.slice(0, Math.max(0, chars.length - Math.max(overflow, 16))).join("");
      json = JSON.stringify({ ...event, [field]: text, truncated: true });
    }
  }
  // A big `data` object is not needed to ring: drop it before the push gets rejected.
  if (event.type === "alert.new" && Buffer.byteLength(json) > MAX_EVENT_BYTES) {
    const { data: _data, ...rest } = event as unknown as Record<string, unknown> & { data?: unknown };
    json = JSON.stringify({ ...rest, truncated: true });
  }
  return { v: "1", relay_id: relayId, event: json, sig: signEvent(pushSecret, json) };
}

interface PushRule {
  ttlSeconds: number;
  highPriority: boolean;
}

/** Which events wake the phone. Everything else is delivered over the WebSocket only. */
async function ruleFor(event: Event, getCall: CallLookup): Promise<PushRule | undefined> {
  switch (event.type) {
    case "alert.new":
      // A locked phone must ring even in Doze; the app shows the alarm itself.
      return { ttlSeconds: MESSAGE_TTL_S, highPriority: true };
    case "alert.ack":
      // Stop the alarm on the other phones.
      return { ttlSeconds: 300, highPriority: true };
    case "msg.new":
      return event.from === "agent" ? { ttlSeconds: MESSAGE_TTL_S, highPriority: true } : undefined;
    case "call.invite":
      // Never deliver an invite after it expired: TTL = time left to ring.
      return event.direction === "agent_to_user"
        ? { ttlSeconds: Math.max(1, Math.ceil((event.expires_at - Date.now()) / 1000)), highPriority: true }
        : undefined;
    case "call.accept":
      // Lets the other phones offer "join the call" (also those whose ring ended or
      // that never got the invite). Normal priority: it doesn't need to wake a phone
      // in Doze, and a high-priority push that shows nothing (the phones still
      // ringing) gets the app's later pushes deprioritized.
      return event.by === "user" && (await getCall(event.call_id))?.direction === "agent_to_user"
        ? { ttlSeconds: CALL_JOINABLE_TTL_S, highPriority: false }
        : undefined;
    // call.decline is not pushed: in a group call one phone declining doesn't affect the others.
    case "call.end":
    case "call.missed":
      // Stops the ringing on every device (or tears down the call screen).
      return (await getCall(event.call_id))?.direction === "agent_to_user"
        ? { ttlSeconds: CALL_UPDATE_TTL_S, highPriority: true }
        : undefined;
    default:
      return undefined;
  }
}

export class PushDispatcher {
  constructor(
    private readonly db: Db,
    private readonly provider: PushProvider | undefined,
    private readonly relayId: string,
    private readonly log: FastifyBaseLogger,
    private readonly getCall: CallLookup = async () => undefined,
  ) {}

  async handle(event: Event): Promise<void> {
    if (!this.provider) return;
    const rule = await ruleFor(event, this.getCall);
    if (!rule) return;
    const devices = await this.db
      .prepare("SELECT device_id, push_secret, fcm_token FROM devices WHERE revoked_at IS NULL AND fcm_token IS NOT NULL")
      .all() as Array<{ device_id: string; push_secret: string; fcm_token: string }>;
    // A targeted call's pushes only go to the phones it targets.
    const callInfo = event.type.startsWith("call.") ? await this.getCall((event as { call_id: string }).call_id) : undefined;
    const targets = callInfo?.device_ids;
    for (const d of devices) {
      if (targets && !targets.includes(d.device_id)) continue;
      // The phone that joined already knows.
      if (event.type === "call.accept" && event.device_id === d.device_id) continue;
      const payload = buildPayload(this.relayId, d.push_secret, event);
      void this.provider
        .send({ deviceId: d.device_id, token: d.fcm_token }, payload, rule)
        .then(async (res) => {
          if (res.ok) {
            this.log.debug({ device: d.device_id, event: event.type }, "push sent");
            return;
          }
          this.log.warn({ device: d.device_id, event: event.type, error: res.error }, "push failed");
          if (res.unregistered) {
            await this.db
              .prepare("UPDATE devices SET fcm_token = NULL WHERE device_id = ? AND fcm_token = ?")
              .run(d.device_id, d.fcm_token);
          }
        })
        .catch((e: unknown) => this.log.error({ err: e, device: d.device_id }, "push error"));
    }
  }
}
