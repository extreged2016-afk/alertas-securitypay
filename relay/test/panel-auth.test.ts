import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { buildHub } from "../src/hub/hub.js";
import { PANEL_COOKIE_NAME, maskApiKey } from "../src/panel-auth.js";
import { AGENT, FakeLiveKit, FakePush, pairDevice, setup, testConfig } from "./helpers.js";

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function app(over = {}) {
  const b = await setup(over);
  cleanup.push(() => b.app.close());
  return b;
}

function extractCookiePair(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw).toBeTruthy();
  return raw!.split(";")[0]!;
}

describe("panel simple password + persistent session cookie", () => {
  it("masks API keys without leaking the secret", () => {
    expect(maskApiKey("ak_securitypay_alertas_2026")).toBe("ak_…2026");
    expect(maskApiKey("ak_short")).toBe("ak_…hort");
    expect(maskApiKey("ak_1")).toBe("ak_…");
  });

  it("logs in with PANEL_PASSWORD, sets an HttpOnly 30-day cookie, and authenticates REST + pairing + WS", async () => {
    const b = await app({ panelPassword: "MiClaveFacil2026" });

    // Unauthenticated session check reveals no secrets.
    const before = await b.app.inject({ url: "/v1/panel/session" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      supported: true,
      authenticated: false,
      password_configured: true,
      password_source: "env",
      agent_name: "TestAgent",
    });
    expect(before.body).not.toContain("ak_test_key");

    // Login with trimmed simple password (simulated HTTPS proxy headers).
    const login = await b.app.inject({
      method: "POST",
      url: "/v1/panel/login",
      headers: { "x-forwarded-proto": "https", origin: "https://relay.test" },
      payload: { secret: "  MiClaveFacil2026  ", remember: true },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ ok: true, password_configured: true, password_source: "env" });
    const rawSetCookie = String(login.headers["set-cookie"]);
    expect(rawSetCookie).toContain(`${PANEL_COOKIE_NAME}=`);
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("SameSite=Lax");
    expect(rawSetCookie).toContain("Max-Age=2592000");
    expect(rawSetCookie).toContain("Secure");

    const cookie = extractCookiePair(login.headers["set-cookie"]);

    // Session endpoint now reports authenticated = true.
    const after = await b.app.inject({ url: "/v1/panel/session", headers: { cookie } });
    expect(after.json().authenticated).toBe(true);

    // Status, alerts, pairing tokens, and panel credentials all work via the session cookie.
    expect((await b.app.inject({ url: "/v1/status", headers: { cookie } })).statusCode).toBe(200);
    const created = await b.app.inject({
      method: "POST",
      url: "/v1/alerts",
      headers: { cookie, origin: "https://relay.test" },
      payload: { type: "test", title: "Hola", message: "Desde cookie", priority: "normal" },
    });
    expect(created.statusCode).toBe(201);

    const pairTok = await b.app.inject({
      method: "POST",
      url: "/v1/pairing-tokens",
      headers: { cookie, origin: "https://relay.test" },
      payload: { ttl_s: 300 },
    });
    expect(pairTok.statusCode).toBe(201);

    const creds = await b.app.inject({ url: "/v1/panel/credentials", headers: { cookie } });
    expect(creds.statusCode).toBe(200);
    expect(creds.json()).toEqual({
      api_key: "ak_test_key",
      api_key_source: "env",
      api_key_hint: "ak_…_key",
      can_rotate_api_key: false,
      password_configured: true,
      password_source: "env",
      can_change_password: false,
    });

    // Device-only endpoints reject the panel cookie with 403 (same as agent API key).
    const devOnly = await b.app.inject({
      method: "POST",
      url: "/v1/device/fcm",
      headers: { cookie, origin: "https://relay.test" },
      payload: { fcm_token: "abc" },
    });
    expect(devOnly.statusCode).toBe(403);

    // Explicit invalid Bearer header never falls back to a valid cookie.
    const badBearer = await b.app.inject({
      url: "/v1/status",
      headers: { cookie, authorization: "Bearer ak_wrong" },
    });
    expect(badBearer.statusCode).toBe(401);

    // WebSocket /ws/relay authenticates via the same-origin cookie without ?token=.
    await b.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (b.app.server.address() as AddressInfo).port;
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/relay?after_seq=0`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    cleanup.push(() => Promise.resolve(ws.close()));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const deadline = Date.now() + 2000;
    while (!frames.some((f) => f.type === "alert.new") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(frames.some((f) => f.type === "ws.hello")).toBe(true);
    expect(frames.some((f) => f.type === "alert.new" && f.title === "Hola")).toBe(true);

    // Cross-origin WebSocket upgrade with cookie is blocked (CSWSH protection).
    const evilWs = new WebSocket(`ws://127.0.0.1:${port}/ws/relay`, {
      headers: { cookie, origin: "https://evil.example" },
    });
    const evilStatus = await new Promise<number | undefined>((resolve) =>
      evilWs.once("unexpected-response", (_req, res) => resolve(res.statusCode)),
    );
    expect(evilStatus).toBe(403);

    // Logout clears the session cookie.
    const logout = await b.app.inject({
      method: "POST",
      url: "/v1/panel/logout",
      headers: { cookie, origin: "https://relay.test" },
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("also accepts the relay API key in /v1/panel/login and enforces CSRF checks + rate limiting", async () => {
    const b = await app({ panelPassword: "OtherPassword" });

    // Login with active API key also succeeds.
    const okKey = await b.app.inject({
      method: "POST",
      url: "/v1/panel/login",
      payload: { secret: "ak_test_key", remember: false },
    });
    expect(okKey.statusCode).toBe(200);
    expect(String(okKey.headers["set-cookie"])).not.toContain("Max-Age=");
    const cookie = extractCookiePair(okKey.headers["set-cookie"]);

    // Cross-origin state-changing requests with cookie are blocked with 403.
    const badOrigin = await b.app.inject({
      method: "POST",
      url: "/v1/alerts",
      headers: { cookie, origin: "https://attacker.example" },
      payload: { type: "x", title: "x", message: "x" },
    });
    expect(badOrigin.statusCode).toBe(403);

    const crossSite = await b.app.inject({
      method: "POST",
      url: "/v1/alerts",
      headers: { cookie, "sec-fetch-site": "cross-site" },
      payload: { type: "x", title: "x", message: "x" },
    });
    expect(crossSite.statusCode).toBe(403);

    // Rate limits repeated wrong passwords per client IP.
    for (let i = 0; i < 10; i++) {
      const r = await b.app.inject({
        method: "POST",
        url: "/v1/panel/login",
        headers: { "x-forwarded-for": "198.51.100.42" },
        payload: { secret: "wrong" },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await b.app.inject({
      method: "POST",
      url: "/v1/panel/login",
      headers: { "x-forwarded-for": "198.51.100.42" },
      payload: { secret: "OtherPassword" },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("lets self-hosted users set a DB panel password, invalidates older sessions, and rotates DB API keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "securitypay-panel-"));
    cleanup.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));

    const b1 = await buildApp(testConfig({ dataDir: dir, apiKey: undefined }), {
      logger: false,
      pushProvider: new FakePush(),
      livekit: new FakeLiveKit(),
    });
    let closed1 = false;
    cleanup.push(async () => {
      if (!closed1) await b1.app.close();
    });

    const initialKey = b1.apiKey;
    expect(initialKey).toMatch(/^ak_/);

    // Log in with generated API key -> get cookie1.
    const login1 = await b1.app.inject({
      method: "POST",
      url: "/v1/panel/login",
      payload: { secret: initialKey, remember: true },
    });
    expect(login1.statusCode).toBe(200);
    const cookie1 = extractCookiePair(login1.headers["set-cookie"]);

    // Set a simple panel password in the database.
    const setPw = await b1.app.inject({
      method: "POST",
      url: "/v1/panel/password",
      headers: { cookie: cookie1, origin: "https://relay.test" },
      payload: { password: "MiPasswordSegura" },
    });
    expect(setPw.statusCode).toBe(200);
    const cookie2 = extractCookiePair(setPw.headers["set-cookie"]);

    // Old cookie is invalidated immediately by the session version bump; new cookie works.
    expect((await b1.app.inject({ url: "/v1/status", headers: { cookie: cookie1 } })).statusCode).toBe(401);
    expect((await b1.app.inject({ url: "/v1/status", headers: { cookie: cookie2 } })).statusCode).toBe(200);

    // Rotate the DB-managed API key from inside the panel.
    const pendingPair = (
      await b1.app.inject({ method: "POST", url: "/v1/pairing-tokens", headers: { cookie: cookie2 } })
    ).json();
    const rot = await b1.app.inject({
      method: "POST",
      url: "/v1/panel/rotate-api-key",
      headers: { cookie: cookie2, origin: "https://relay.test" },
    });
    expect(rot.statusCode).toBe(200);
    const newKey = rot.json().api_key as string;
    expect(newKey).toMatch(/^ak_/);
    expect(newKey).not.toBe(initialKey);

    // Old API key and pending pairing tokens are invalidated immediately; new key works.
    expect((await b1.app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${initialKey}` } })).statusCode).toBe(401);
    expect((await b1.app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${newKey}` } })).statusCode).toBe(200);
    expect(
      (
        await b1.app.inject({
          method: "POST",
          url: "/v1/pair",
          payload: { pairing_token: pendingPair.pairing_token, device_name: "Phone", platform: "android" },
        })
      ).statusCode,
    ).toBe(401);

    // Simulate Render restart: close and rebuild on the same database.
    await b1.app.close();
    closed1 = true;

    const b2 = await buildApp(testConfig({ dataDir: dir, apiKey: undefined }), {
      logger: false,
      pushProvider: new FakePush(),
      livekit: new FakeLiveKit(),
    });
    cleanup.push(() => b2.app.close());

    // The 30-day session cookie AND the DB password AND the rotated API key all survive restarts!
    expect((await b2.app.inject({ url: "/v1/status", headers: { cookie: cookie2 } })).statusCode).toBe(200);
    expect((await b2.app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${newKey}` } })).statusCode).toBe(200);
    const loginAfterRestart = await b2.app.inject({
      method: "POST",
      url: "/v1/panel/login",
      payload: { secret: "MiPasswordSegura" },
    });
    expect(loginAfterRestart.statusCode).toBe(200);
  });

  it("refuses DB password update and API key rotation when managed by env vars", async () => {
    const b = await app({ panelPassword: "EnvPassword123" });
    const pwRes = await b.app.inject({
      method: "POST",
      url: "/v1/panel/password",
      headers: AGENT,
      payload: { password: "AnotherPassword" },
    });
    expect(pwRes.statusCode).toBe(409);
    expect(pwRes.json().error.code).toBe("invalid_state");

    const rotRes = await b.app.inject({
      method: "POST",
      url: "/v1/panel/rotate-api-key",
      headers: AGENT,
    });
    expect(rotRes.statusCode).toBe(409);
    expect(rotRes.json().error.code).toBe("invalid_state");

    // Device JWT cannot read panel credentials.
    const dev = await pairDevice(b);
    expect((await b.app.inject({ url: "/v1/panel/credentials", headers: dev.headers })).statusCode).toBe(403);
  });

  it("keeps multi-tenant hub mode isolated from self-hosted panel routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "securitypay-hub-panel-"));
    cleanup.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));

    const ADMIN_TOKEN = "admin-token-0123456789-0123456789-abcdef";
    const { app: hubApp } = await buildHub(testConfig({ dataDir: dir, panelPassword: "ShouldNotApplyToTenants" }), {
      adminToken: ADMIN_TOKEN,
      logger: false,
      livekit: new FakeLiveKit(),
      pushProvider: new FakePush(),
    });
    cleanup.push(() => hubApp.close());
    await hubApp.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(hubApp.server.address() as AddressInfo).port}`;

    const created = await hubApp.inject({
      method: "POST",
      url: "/admin/v1/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { agent_name: "T1" },
    });
    const { tenant, api_key } = created.json() as { tenant: { tenant_id: string }; api_key: string };

    const sess = await fetch(`${base}/t/${tenant.tenant_id}/v1/panel/session`);
    expect(sess.status).toBe(200);
    expect(await sess.json()).toMatchObject({ supported: false, authenticated: false });

    const login = await fetch(`${base}/t/${tenant.tenant_id}/v1/panel/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "ShouldNotApplyToTenants" }),
    });
    expect(login.status).toBe(404);

    const creds = await fetch(`${base}/t/${tenant.tenant_id}/v1/panel/credentials`, {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(creds.status).toBe(404);
  });
});
