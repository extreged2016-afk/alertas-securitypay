import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { signEvent } from "../src/push/dispatcher.js";
import { AGENT, pairDevice, setup } from "./helpers.js";

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function app() {
  const b = await setup();
  cleanup.push(() => b.app.close());
  return b;
}

const alertBody = {
  type: "error",
  title: "La API se cayó",
  message: "El healthcheck de Render falló 3 veces.",
  priority: "critical",
  source: "render-api",
  data: { service: "api" },
};

describe("alert center", () => {
  it("creates, lists and acknowledges an alert", async () => {
    const b = await app();
    const created = await b.app.inject({ method: "POST", url: "/v1/alerts", headers: AGENT, payload: alertBody });
    expect(created.statusCode).toBe(201);
    const alert = created.json();
    expect(alert.alert_id).toMatch(/^alert_/);
    expect(alert.voice_room).toMatch(/^alert-alert_/);
    expect(b.livekit.created).toContain(alert.voice_room);

    const page = await b.app.inject({ url: "/v1/alerts", headers: AGENT });
    expect(page.statusCode).toBe(200);
    expect(page.json().alerts).toHaveLength(1);
    expect(page.json().alerts[0]).toMatchObject({ title: alertBody.title, priority: "critical" });

    const ack = await b.app.inject({ method: "POST", url: `/v1/alerts/${alert.alert_id}/ack`, headers: AGENT });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().acked_by).toBe("agent");
    expect(ack.json().acked_at).toBeTypeOf("number");

    const events = (await b.app.inject({ url: "/v1/events?after_seq=0&limit=100", headers: AGENT })).json().events;
    expect(events.map((e: { type: string }) => e.type)).toContain("alert.new");
    expect(events.map((e: { type: string }) => e.type)).toContain("alert.ack");
  });

  it("pushes a signed alert.new event to paired phones", async () => {
    const b = await app();
    const device = await pairDevice(b);
    await b.app.inject({ method: "POST", url: "/v1/alerts", headers: AGENT, payload: alertBody });
    const sent = b.push.sent.at(-1)!;
    expect(sent).toBeTruthy();
    expect(sent.opts.highPriority).toBe(true);
    expect(sent.payload.relay_id).toBe(b.ctx.relayId);
    expect(sent.payload.sig).toBe(signEvent(device.push_secret, sent.payload.event));
    const event = JSON.parse(sent.payload.event);
    expect(event).toMatchObject({ type: "alert.new", priority: "critical", title: alertBody.title });
    expect(event.voice_room).toBeTypeOf("string");
  });

  it("gives phones a listen-only token and the voice worker a publishing token", async () => {
    const b = await app();
    const device = await pairDevice(b);
    const alert = (await b.app.inject({ method: "POST", url: "/v1/alerts", headers: AGENT, payload: alertBody })).json();

    const phone = await b.app.inject({
      method: "POST",
      url: `/v1/alerts/${alert.alert_id}/voice-token`,
      headers: device.headers,
    });
    expect(phone.statusCode).toBe(200);
    expect(phone.json()).toMatchObject({ livekit_url: "wss://lk.test", identity: `device_${device.device_id}` });

    const worker = await b.app.inject({
      method: "POST",
      url: `/v1/alerts/${alert.alert_id}/voice-token`,
      headers: AGENT,
    });
    expect(worker.statusCode).toBe(200);
    expect(worker.json().identity).toBe("voice-agent");
  });

  it("accepts /ws/relay with ?token= and streams the alert", async () => {
    const b = await app();
    await b.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (b.app.server.address() as { port: number }).port;
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/relay?token=ak_test_key`);
    cleanup.push(() => Promise.resolve(ws.close()));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 60));
    await b.app.inject({ method: "POST", url: "/v1/alerts", headers: AGENT, payload: alertBody });
    const deadline = Date.now() + 2000;
    while (!frames.some((f) => f.type === "alert.new") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(frames.some((f) => f.type === "ws.hello")).toBe(true);
    expect(frames.find((f) => f.type === "alert.new")).toMatchObject({ priority: "critical", title: alertBody.title });
  });

  it("rejects unauthenticated alert creation and invalid priorities", async () => {
    const b = await app();
    const unauth = await b.app.inject({ method: "POST", url: "/v1/alerts", payload: alertBody });
    expect(unauth.statusCode).toBe(401);
    const bad = await b.app.inject({
      method: "POST",
      url: "/v1/alerts",
      headers: AGENT,
      payload: { ...alertBody, priority: "apocaliptic" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("has no plan limits when self-hosted", async () => {
    const b = await app();
    for (let i = 0; i < 30; i++) {
      const r = await b.app.inject({
        method: "POST",
        url: "/v1/alerts",
        headers: AGENT,
        payload: { ...alertBody, priority: "normal", title: `Alerta ${i}` },
      });
      expect(r.statusCode).toBe(201);
    }
    const page = await b.app.inject({ url: "/v1/alerts?limit=500", headers: AGENT });
    expect(page.json().alerts).toHaveLength(30);
  });
});
