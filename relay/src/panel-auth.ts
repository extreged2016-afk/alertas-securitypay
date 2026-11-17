import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { sha256 } from "./auth.js";
import type { Config } from "./config.js";
import { type Db, getMeta, metaOrInit, setMeta } from "./db/database.js";
import { ApiError, forbidden } from "./errors.js";
import { randomToken } from "./ids.js";

const scryptAsync = promisify(scrypt);

export const PANEL_COOKIE_NAME = "sp_panel_session";
export const PANEL_SESSION_REMEMBER_S = 30 * 24 * 60 * 60; // 30 days
export const PANEL_SESSION_SHORT_S = 24 * 60 * 60; // 24 hours (session cookie)

export type ApiKeySource = "env" | "database";
export type PanelPasswordSource = "env" | "database" | "none";

/** Returns a non-secret hint like `ak_…2026` safe for logs and masked UI display. */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.startsWith("ak_") && key.length >= 10) return `ak_…${key.slice(-4)}`;
  if (key.length >= 8) return `${key.slice(0, 3)}…${key.slice(-4)}`;
  return "ak_…";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function formatSetCookie(
  name: string,
  value: string,
  opts: { maxAgeS?: number; secure: boolean; clear?: boolean },
): string {
  const parts = [`${name}=${opts.clear ? "" : encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (opts.clear) {
    parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else if (opts.maxAgeS !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeS))}`);
  }
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function isHttpsRequest(req: FastifyRequest, cfg: Config): boolean {
  if (req.protocol === "https") return true;
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.split(",")[0]?.trim().toLowerCase() === "https") return true;
  const host = (req.hostname || "").toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  return !isLoopback && !cfg.insecureDev && cfg.publicUrl.startsWith("https://");
}

function allowedOrigins(req: FastifyRequest, cfg: Config): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(cfg.publicUrl).origin.toLowerCase());
  } catch {
    // ignore malformed publicUrl
  }
  const host = req.headers.host?.trim().toLowerCase();
  if (host) {
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return origins;
}

/**
 * Defense-in-depth CSRF / CSWSH guard for cookie-authenticated requests:
 * blocks cross-site state changes and cross-origin WebSocket upgrades.
 */
export function assertSameOriginForCookie(req: FastifyRequest, cfg: Config): void {
  const method = req.method.toUpperCase();
  const isWsUpgrade = req.headers.upgrade?.toLowerCase() === "websocket";
  const isSafeHttp = !isWsUpgrade && (method === "GET" || method === "HEAD" || method === "OPTIONS");
  if (isSafeHttp) return;

  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.trim().toLowerCase() === "cross-site") {
    throw forbidden("Cross-site request blocked");
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim() !== "") {
    const normalized = origin.trim().toLowerCase();
    if (!allowedOrigins(req, cfg).has(normalized)) {
      throw forbidden("Cross-origin request blocked");
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hex] = parts;
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== 32) return false;
  const derived = (await scryptAsync(password, salt, 32)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface PanelAuthOptions {
  db: Db;
  cfg: Config;
  jwtSecret: string;
  relayId: string;
  initialApiKey: string;
  apiKeySource: ApiKeySource;
  onApiKeyRotated?: () => Promise<void> | void;
}

/**
 * Manages self-hosted web panel authentication:
 * - Simple password login (PANEL_PASSWORD env var, DB-stored scrypt password, or active API key)
 * - Persistent HttpOnly HS256 session cookies (surviving restarts via jwt_secret in DB)
 * - In-panel API key inspection & rotation (when DB-managed)
 */
export class PanelAuth {
  private readonly jwtKey: Uint8Array;
  private currentApiKey: string;
  private currentApiKeyHash: Buffer;
  private sessionVersion: number;
  readonly apiKeySource: ApiKeySource;

  private constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    jwtSecret: string,
    private readonly relayId: string,
    initialApiKey: string,
    apiKeySource: ApiKeySource,
    sessionVersion: number,
    private onApiKeyRotated?: () => Promise<void> | void,
  ) {
    this.jwtKey = Buffer.from(jwtSecret, "base64url");
    this.currentApiKey = initialApiKey;
    this.currentApiKeyHash = sha256(initialApiKey);
    this.apiKeySource = apiKeySource;
    this.sessionVersion = sessionVersion;
  }

  static async create(opts: PanelAuthOptions): Promise<PanelAuth> {
    const rawVer = await metaOrInit(opts.db, "panel_session_version", () => "1");
    const ver = Number.parseInt(rawVer, 10);
    const sessionVersion = Number.isFinite(ver) && ver > 0 ? ver : 1;
    return new PanelAuth(
      opts.db,
      opts.cfg,
      opts.jwtSecret,
      opts.relayId,
      opts.initialApiKey,
      opts.apiKeySource,
      sessionVersion,
      opts.onApiKeyRotated,
    );
  }

  setRotationHook(fn: () => Promise<void> | void): void {
    this.onApiKeyRotated = fn;
  }

  apiKey(): string {
    return this.currentApiKey;
  }

  apiKeyHash(): Buffer {
    return this.currentApiKeyHash;
  }

  apiKeyHint(): string {
    return maskApiKey(this.currentApiKey);
  }

  async passwordSource(): Promise<PanelPasswordSource> {
    if (this.cfg.panelPassword) return "env";
    const stored = await getMeta(this.db, "panel_password_hash");
    return stored ? "database" : "none";
  }

  /** Accepts PANEL_PASSWORD (or DB password) as well as the active relay API key. */
  async verifySecret(raw: string): Promise<boolean> {
    const secret = raw.trim();
    if (!secret) return false;

    if (this.cfg.panelPassword) {
      if (timingSafeEqual(sha256(secret), sha256(this.cfg.panelPassword))) return true;
    } else {
      const stored = await getMeta(this.db, "panel_password_hash");
      if (stored && (await verifyPasswordHash(secret, stored))) return true;
    }

    if (secret.startsWith("ak_") && timingSafeEqual(sha256(secret), this.currentApiKeyHash)) {
      return true;
    }
    return false;
  }

  async setPassword(raw: string): Promise<void> {
    if (this.cfg.panelPassword) {
      throw new ApiError(
        409,
        "invalid_state",
        "La contraseña está gestionada por la variable de entorno PANEL_PASSWORD.",
      );
    }
    const password = raw.trim();
    if (password.length < 4 || password.length > 128) {
      throw new ApiError(400, "invalid_request", "La contraseña debe tener entre 4 y 128 caracteres.");
    }
    const hash = await hashPassword(password);
    await setMeta(this.db, "panel_password_hash", hash);
    await this.bumpSessionVersion();
  }

  async rotateApiKey(): Promise<string> {
    if (this.apiKeySource === "env") {
      throw new ApiError(
        409,
        "invalid_state",
        "La clave de API está fijada por la variable de entorno SECURITYPAY_API_KEY.",
      );
    }
    const next = randomToken("ak");
    await setMeta(this.db, "api_key", next);
    if (this.cfg.dataDir !== ":memory:") {
      try {
        mkdirSync(this.cfg.dataDir, { recursive: true });
        const file = join(this.cfg.dataDir, "api_key");
        writeFileSync(file, next + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
      } catch (err) {
        if (this.db.dialect !== "postgres") throw err;
      }
    }
    this.currentApiKey = next;
    this.currentApiKeyHash = sha256(next);
    await this.onApiKeyRotated?.();
    return next;
  }

  async bumpSessionVersion(): Promise<number> {
    this.sessionVersion += 1;
    await setMeta(this.db, "panel_session_version", String(this.sessionVersion));
    return this.sessionVersion;
  }

  async issueSession(remember = true): Promise<{ token: string; expiresAt: number; maxAgeS?: number }> {
    const ttlS = remember ? PANEL_SESSION_REMEMBER_S : PANEL_SESSION_SHORT_S;
    const nowS = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ver: this.sessionVersion })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.relayId)
      .setSubject("panel")
      .setAudience("panel")
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + ttlS)
      .sign(this.jwtKey);
    return {
      token,
      expiresAt: (nowS + ttlS) * 1000,
      ...(remember ? { maxAgeS: PANEL_SESSION_REMEMBER_S } : {}),
    };
  }

  async verifySession(token: string): Promise<boolean> {
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.relayId,
        audience: "panel",
        algorithms: ["HS256"],
      });
      return payload.sub === "panel" && payload.ver === this.sessionVersion;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if the request carries a valid panel session cookie.
   * Enforces same-origin checks on state-changing HTTP methods and WS upgrades.
   */
  async authenticateCookie(req: FastifyRequest): Promise<boolean> {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[PANEL_COOKIE_NAME];
    if (!token) return false;
    const ok = await this.verifySession(token);
    if (!ok) return false;
    assertSameOriginForCookie(req, this.cfg);
    return true;
  }
}
