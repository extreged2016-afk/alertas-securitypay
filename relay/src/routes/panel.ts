import type { FastifyInstance } from "fastify";
import { type Ctx, requireAgentKey } from "../context.js";
import { ApiError, notFound } from "../errors.js";
import {
  PANEL_COOKIE_NAME,
  assertSameOriginForCookie,
  formatSetCookie,
  isHttpsRequest,
} from "../panel-auth.js";

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_MAX_KEYS = 10_000;

export function panelRoutes(app: FastifyInstance, ctx: Ctx): void {
  const failures = new Map<string, number[]>();

  function pruneFailures(ip: string, now: number): number[] {
    const recent = (failures.get(ip) ?? []).filter((t) => t > now - LOGIN_WINDOW_MS);
    if (recent.length === 0) failures.delete(ip);
    else failures.set(ip, recent);
    return recent;
  }

  function recordFailure(ip: string, now: number): void {
    const recent = (failures.get(ip) ?? []).filter((t) => t > now - LOGIN_WINDOW_MS);
    recent.push(now);
    failures.delete(ip);
    failures.set(ip, recent);
    if (failures.size > LOGIN_MAX_KEYS) {
      for (const [key, times] of failures) {
        if (failures.size > LOGIN_MAX_KEYS || (times.at(-1) ?? 0) <= now - LOGIN_WINDOW_MS) {
          failures.delete(key);
        }
      }
    }
  }

  app.get("/v1/panel/session", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!ctx.panel) {
      return {
        supported: false,
        authenticated: false,
        password_configured: false,
        password_source: "none" as const,
        agent_name: ctx.cfg.agentName,
      };
    }

    let authenticated = false;
    if (req.headers.authorization && req.headers.authorization.length > 0) {
      try {
        const p = await ctx.auth.authenticate(req.headers.authorization);
        authenticated = p.kind === "agent";
      } catch {
        authenticated = false;
      }
    } else {
      try {
        authenticated = await ctx.panel.authenticateCookie(req);
      } catch {
        authenticated = false;
      }
    }

    const passwordSource = await ctx.panel.passwordSource();
    return {
      supported: true,
      authenticated,
      password_configured: passwordSource !== "none",
      password_source: passwordSource,
      agent_name: ctx.cfg.agentName,
    };
  });

  app.post<{ Body: { secret: string; remember?: boolean } }>(
    "/v1/panel/login",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["secret"],
          properties: {
            secret: { type: "string", minLength: 1, maxLength: 512 },
            remember: { type: "boolean", default: true },
          },
        },
      },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!ctx.panel) throw notFound("Panel login");
      assertSameOriginForCookie(req, ctx.cfg);

      const now = Date.now();
      if (pruneFailures(req.ip, now).length >= LOGIN_MAX_FAILURES) {
        throw new ApiError(429, "rate_limited", "Demasiados intentos. Espera un minuto y vuelve a intentarlo.");
      }

      const ok = await ctx.panel.verifySecret(req.body.secret);
      if (!ok) {
        recordFailure(req.ip, now);
        throw new ApiError(401, "unauthorized", "Contraseña o clave de API no válida.");
      }

      failures.delete(req.ip);
      const remember = req.body.remember !== false;
      const session = await ctx.panel.issueSession(remember);
      const cookie = formatSetCookie(PANEL_COOKIE_NAME, session.token, {
        maxAgeS: session.maxAgeS,
        secure: isHttpsRequest(req, ctx.cfg),
      });
      reply.header("set-cookie", cookie);

      const passwordSource = await ctx.panel.passwordSource();
      req.log.info({ remember }, "panel session created");
      return {
        ok: true,
        expires_at: session.expiresAt,
        password_configured: passwordSource !== "none",
        password_source: passwordSource,
      };
    },
  );

  app.post("/v1/panel/logout", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (ctx.panel) {
      assertSameOriginForCookie(req, ctx.cfg);
      reply.header(
        "set-cookie",
        formatSetCookie(PANEL_COOKIE_NAME, "", { clear: true, secure: isHttpsRequest(req, ctx.cfg) }),
      );
    }
    return { ok: true };
  });

  app.get("/v1/panel/credentials", { preHandler: requireAgentKey(ctx) }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (!ctx.panel) throw notFound("Panel credentials");
    const passwordSource = await ctx.panel.passwordSource();
    return {
      api_key: ctx.panel.apiKey(),
      api_key_source: ctx.panel.apiKeySource,
      api_key_hint: ctx.panel.apiKeyHint(),
      can_rotate_api_key: ctx.panel.apiKeySource === "database",
      password_configured: passwordSource !== "none",
      password_source: passwordSource,
      can_change_password: passwordSource !== "env",
    };
  });

  app.post<{ Body: { password: string } }>(
    "/v1/panel/password",
    {
      preHandler: requireAgentKey(ctx),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["password"],
          properties: {
            password: { type: "string", minLength: 4, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (!ctx.panel) throw notFound("Panel password");
      await ctx.panel.setPassword(req.body.password);
      // Re-issue a fresh session cookie for the caller so they stay signed in after the version bump.
      const session = await ctx.panel.issueSession(true);
      reply.header(
        "set-cookie",
        formatSetCookie(PANEL_COOKIE_NAME, session.token, {
          maxAgeS: session.maxAgeS,
          secure: isHttpsRequest(req, ctx.cfg),
        }),
      );
      req.log.info("panel password updated");
      return { ok: true, password_configured: true, password_source: "database" as const };
    },
  );

  app.post("/v1/panel/rotate-api-key", { preHandler: requireAgentKey(ctx) }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!ctx.panel) throw notFound("API key rotation");
    const apiKey = await ctx.panel.rotateApiKey();
    req.log.info({ api_key_hint: ctx.panel.apiKeyHint() }, "relay API key rotated from panel");
    return { api_key: apiKey, api_key_hint: ctx.panel.apiKeyHint() };
  });
}
