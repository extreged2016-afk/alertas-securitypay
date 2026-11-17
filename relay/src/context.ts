import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Auth, Principal } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db/database.js";
import type { EventLog } from "./events.js";
import type { LiveKitService } from "./livekit.js";
import { forbidden } from "./errors.js";
import type { PanelAuth } from "./panel-auth.js";
import type { PushConfig } from "./protocol.js";
import type { Limits } from "./quota.js";
import type { Calls } from "./routes/calls.js";
import type { WsHub } from "./routes/ws.js";

export interface Ctx {
  cfg: Config;
  log: FastifyBaseLogger;
  db: Db;
  auth: Auth;
  /** Present on self-hosted relays; undefined for hub tenants. */
  panel?: PanelAuth;
  events: EventLog;
  relayId: string;
  pushConfig: PushConfig;
  pushProviderName: string;
  hub: WsHub;
  /** Undefined when LiveKit isn't configured: calls are then unavailable. */
  livekit?: LiveKitService;
  calls?: Calls;
  /** The tenant's current limits (hub mode); unlimited on a self-hosted relay. */
  limits: () => Limits;
  /** Prefix of LiveKit room names ("" self-hosted, "{tenant_id}." in hub mode: one LiveKit for all tenants). */
  roomPrefix: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

type Kind = Principal["kind"];

async function authenticateRequest(ctx: Ctx, req: FastifyRequest, queryToken?: string): Promise<Principal> {
  if (queryToken && queryToken.length > 0) {
    return ctx.auth.authenticate(`Bearer ${queryToken}`);
  }
  if (req.headers.authorization && req.headers.authorization.length > 0) {
    return ctx.auth.authenticate(req.headers.authorization);
  }
  if (ctx.panel && (await ctx.panel.authenticateCookie(req))) {
    return { kind: "agent" };
  }
  return ctx.auth.authenticate(undefined);
}

/** Fastify preHandler that authenticates and restricts to the given principal kinds. */
export function requireAuth(ctx: Ctx, ...kinds: Kind[]) {
  return async (req: FastifyRequest) => {
    const p = await authenticateRequest(ctx, req);
    if (!kinds.includes(p.kind)) throw forbidden(`This endpoint is not available to ${p.kind} credentials`);
    req.principal = p;
  };
}

/**
 * Same as [requireAuth], but also accepts `?token=` for browser WebSockets, which
 * cannot set an Authorization header. Used by `/ws/relay`; prefer same-origin
 * panel session cookies or the Authorization header when supported.
 */
export function requireAuthQuery(ctx: Ctx, ...kinds: Kind[]) {
  return async (req: FastifyRequest) => {
    const rawToken = (req.query as { token?: unknown } | undefined)?.token;
    const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : undefined;
    const p = await authenticateRequest(ctx, req, token);
    if (!kinds.includes(p.kind)) throw forbidden(`This endpoint is not available to ${p.kind} credentials`);
    req.principal = p;
  };
}

/**
 * The tenant's API key (or self-hosted panel session) only: pairing phones, revoking
 * them, and managing panel credentials need it. A short-lived agent token (`at_…`)
 * must not be able to mint a credential that outlives it.
 */
export function requireAgentKey(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const p = await authenticateRequest(ctx, req);
    if (p.kind !== "agent") throw forbidden(`This endpoint is not available to ${p.kind} credentials`);
    if (p.expiresAt !== undefined) throw forbidden("This endpoint needs the API key, not a short-lived agent token");
    req.principal = p;
  };
}

export function principal(req: FastifyRequest): Principal {
  if (!req.principal) throw new Error("route is missing requireAuth");
  return req.principal;
}
