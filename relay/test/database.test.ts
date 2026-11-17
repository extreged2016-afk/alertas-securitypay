import { afterEach, describe, expect, it } from "vitest";
import {
  createPgDbFromPool,
  formatPgStartupError,
  openDatabase,
  parsePgConnectionConfig,
  PG_MIGRATIONS,
  type PgPoolLike,
  runPgMigrations,
  toPg,
} from "../src/db/database.js";
import { EventLog } from "../src/events.js";
import { callMsThisMonth } from "../src/quota.js";
import { setup } from "./helpers.js";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

/** In-memory spy pool that records every query sent to the pool vs checked-out clients. */
function makeFakePgPool(options: { initialVersion?: number; failOnSql?: RegExp } = {}) {
  const poolQueries: Array<{ sql: string; params?: unknown[] }> = [];
  const clientQueries: Array<{ clientId: number; sql: string; params?: unknown[] }> = [];
  let version = options.initialVersion ?? 0;
  let hasSchemaVersionRow = options.initialVersion !== undefined;
  let seqCounter = 0;
  let nextClientId = 0;
  let released = 0;
  let ended = false;

  const handleQuery = async (
    sql: string,
    params: unknown[] | undefined,
    record: () => void,
  ): Promise<{ rows: any[]; rowCount: number | null }> => {
    record();
    if (options.failOnSql?.test(sql)) {
      throw new Error(`forced failure on: ${sql}`);
    }
    const trimmed = sql.trim();
    if (/^SELECT version FROM schema_version/i.test(trimmed)) {
      return { rows: hasSchemaVersionRow ? [{ version }] : [], rowCount: hasSchemaVersionRow ? 1 : 0 };
    }
    if (/^INSERT INTO schema_version/i.test(trimmed)) {
      hasSchemaVersionRow = true;
      version = 0;
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE schema_version SET version = \$1/i.test(trimmed)) {
      version = Number(params?.[0] ?? version);
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO events .* RETURNING seq/i.test(trimmed)) {
      seqCounter += 1;
      return { rows: [{ seq: seqCounter }], rowCount: 1 };
    }
    if (/^SELECT COALESCE\(SUM\(GREATEST/i.test(trimmed)) {
      return { rows: [{ ms: "12345" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  const pool: PgPoolLike = {
    async query(sql: string, params?: unknown[]) {
      return handleQuery(sql, params, () => poolQueries.push({ sql, params }));
    },
    async connect() {
      const clientId = ++nextClientId;
      return {
        async query(sql: string, params?: unknown[]) {
          return handleQuery(sql, params, () => clientQueries.push({ clientId, sql, params }));
        },
        release() {
          released += 1;
        },
      } as any;
    },
    async end() {
      ended = true;
    },
  };

  return {
    pool,
    poolQueries,
    clientQueries,
    getVersion: () => version,
    getReleased: () => released,
    getConnections: () => nextClientId,
    isEnded: () => ended,
  };
}

describe("toPg placeholder conversion", () => {
  it("converts positional ? placeholders outside string literals", () => {
    expect(toPg("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(toPg("SELECT '?' AS q, 'it''s ? ok' AS s FROM t WHERE id = ?")).toBe(
      "SELECT '?' AS q, 'it''s ? ok' AS s FROM t WHERE id = $1",
    );
  });
});

describe("parsePgConnectionConfig", () => {
  it("configures SSL automatically for Supabase Connection Pooler URIs", () => {
    const { config, meta } = parsePgConnectionConfig(
      "postgresql://postgres.abcdefgh:MySecretPass@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      {},
    );
    expect(config.host).toBe("aws-0-us-east-1.pooler.supabase.com");
    expect(config.port).toBe(6543);
    expect(config.user).toBe("postgres.abcdefgh");
    expect(config.password).toBe("MySecretPass");
    expect(config.database).toBe("postgres");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    expect(config.connectionString).toBeUndefined();
    expect(meta.isSupabasePooler).toBe(true);
    expect(meta.isSupabaseDirect).toBe(false);
    expect(meta.sslEnabled).toBe(true);
  });

  it("handles sslmode=require without triggering strict CA rejection, and respects disable / verify-full", () => {
    const req = parsePgConnectionConfig(
      "postgresql://postgres.abc:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
      {},
    );
    expect(req.config.ssl).toEqual({ rejectUnauthorized: false });

    const dis = parsePgConnectionConfig(
      "postgresql://postgres:pass@db.example.com:5432/app?sslmode=disable",
      {},
    );
    expect(dis.config.ssl).toBe(false);

    const strict = parsePgConnectionConfig(
      "postgresql://postgres:pass@db.example.com:5432/app?sslmode=verify-full",
      {},
    );
    expect(strict.config.ssl).toEqual({ rejectUnauthorized: true });

    const local = parsePgConnectionConfig("postgresql://postgres:pass@localhost:5432/app", {});
    expect(local.config.ssl).toBe(false);
  });

  it("trims quotes/whitespace and supports DATABASE_PASSWORD override for special chars", () => {
    const { config } = parsePgConnectionConfig(
      '  "postgresql://postgres.abc:placeholder@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"  ',
      { DATABASE_PASSWORD: "p@ss#with?special/chars%" },
    );
    expect(config.password).toBe("p@ss#with?special/chars%");
    expect(config.host).toBe("aws-0-sa-east-1.pooler.supabase.com");

    const emptyInUrl = parsePgConnectionConfig(
      "postgresql://postgres.abc:@aws-1-us-west-2.pooler.supabase.com:6543/postgres",
      { DATABASE_PASSWORD: "raw#pass@123" },
    );
    expect(emptyInUrl.config.user).toBe("postgres.abc");
    expect(emptyInUrl.config.password).toBe("raw#pass@123");
    expect(emptyInUrl.config.host).toBe("aws-1-us-west-2.pooler.supabase.com");
    expect(emptyInUrl.config.port).toBe(6543);
    expect(emptyInUrl.config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("detects bracketed and placeholder passwords and flags Supabase direct hosts", () => {
    const p1 = parsePgConnectionConfig(
      "postgresql://postgres:[YOUR-PASSWORD]@db.xyz123.supabase.co:5432/postgres",
      {},
    );
    expect(p1.meta.passwordLooksBracketed).toBe(true);
    expect(p1.meta.passwordLooksPlaceholder).toBe(true);
    expect(p1.meta.isSupabaseDirect).toBe(true);

    const p2 = parsePgConnectionConfig(
      "postgresql://postgres:[ActualPass123]@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      {},
    );
    expect(p2.meta.passwordLooksBracketed).toBe(true);
    expect(p2.meta.passwordLooksPlaceholder).toBe(false);
  });

  it("never leaks the password when DATABASE_URL is malformed", () => {
    const secret = "SuperSecret#Password123";
    let message = "";
    try {
      parsePgConnectionConfig(`postgresql://postgres:${secret}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/i);
    expect(message).not.toContain(secret);
  });
});

describe("formatPgStartupError", () => {
  it("gives targeted hints for 28P01 without ever exposing the password", () => {
    const secret = "MyVerySecretPass";
    const { meta } = parsePgConnectionConfig(
      `postgresql://postgres:[${secret}]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      {},
    );
    const err = formatPgStartupError(
      Object.assign(new Error('password authentication failed for user "postgres"'), { code: "28P01" }),
      meta,
    );
    expect(err.message).toContain("square brackets");
    expect(err.message).toContain("postgres.<project-ref>");
    expect(err.message).toContain("aws-0-us-east-1.pooler.supabase.com:6543");
    expect(err.message).not.toContain(secret);
  });

  it("gives IPv6/pooler hint for ENETUNREACH on Supabase direct host", () => {
    const { meta } = parsePgConnectionConfig(
      "postgresql://postgres:secret@db.myproj.supabase.co:5432/postgres",
      {},
    );
    const err = formatPgStartupError(Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" }), meta);
    expect(err.message).toContain("IPv6");
    expect(err.message).toContain("Connection Pooler");
    expect(err.message).not.toContain("secret");
  });

  it("gives Supabase tenant hint for XX000 Tenant or user not found", () => {
    const { meta } = parsePgConnectionConfig(
      "postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      {},
    );
    const err = formatPgStartupError(Object.assign(new Error("Tenant or user not found"), { code: "XX000" }), meta);
    expect(err.message).toContain("postgres.<project-ref>");
    expect(err.message).not.toContain("secret");
  });
});

describe("Postgres migrations, transactions and SQL dialect", () => {
  it("runs all migrations on a dedicated PoolClient with pg_advisory_xact_lock and releases it", async () => {
    const fake = makeFakePgPool();
    await runPgMigrations(fake.pool, PG_MIGRATIONS);

    // Must never issue BEGIN/COMMIT directly on the pool (random connections).
    expect(fake.poolQueries).toHaveLength(0);
    expect(fake.getConnections()).toBe(1);
    expect(fake.getReleased()).toBe(1);
    expect(fake.getVersion()).toBe(PG_MIGRATIONS.length);
    expect(fake.clientQueries.some((q) => q.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(fake.clientQueries.filter((q) => q.sql === "BEGIN").length).toBe(PG_MIGRATIONS.length + 1);
    expect(fake.clientQueries.filter((q) => q.sql === "COMMIT").length).toBe(PG_MIGRATIONS.length + 1);
  });

  it("rolls back and releases the client if a migration fails", async () => {
    const fake = makeFakePgPool({ failOnSql: /CREATE TABLE IF NOT EXISTS alerts/i });
    await expect(runPgMigrations(fake.pool, PG_MIGRATIONS)).rejects.toThrow(/forced failure/);
    expect(fake.getReleased()).toBe(1);
    expect(fake.clientQueries.some((q) => q.sql === "ROLLBACK")).toBe(true);
  });

  it("emits events atomically on a dedicated Postgres client using RETURNING seq (no bare SAVEPOINT)", async () => {
    const fake = makeFakePgPool({ initialVersion: PG_MIGRATIONS.length });
    const db = await createPgDbFromPool(fake.pool, PG_MIGRATIONS);
    fake.clientQueries.length = 0;

    const log = new EventLog(db);
    const ev = await log.emit({ type: "msg.read", msg_id: "msg_1", by: "agent" });
    expect(ev.seq).toBe(1);
    expect(fake.poolQueries).toHaveLength(0);

    const sqls = fake.clientQueries.map((q) => q.sql.trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("INSERT INTO events");
    expect(sqls[1]).toContain("RETURNING seq");
    expect(sqls[2]).toContain("UPDATE events SET body = $1 WHERE seq = $2");
    expect(sqls[3]).toBe("COMMIT");
    expect(sqls.some((s) => s.startsWith("SAVEPOINT"))).toBe(false);
    expect(fake.getReleased()).toBe(fake.getConnections());
    await db.close();
    expect(fake.isEnded()).toBe(true);
  });

  it("rolls back Postgres EventLog.emit when UPDATE fails", async () => {
    const fake = makeFakePgPool({ initialVersion: PG_MIGRATIONS.length, failOnSql: /^UPDATE events SET body/i });
    const db = await createPgDbFromPool(fake.pool, PG_MIGRATIONS);
    fake.clientQueries.length = 0;

    const log = new EventLog(db);
    await expect(log.emit({ type: "msg.read", msg_id: "msg_1", by: "agent" })).rejects.toThrow(/forced failure/);
    expect(fake.clientQueries.map((q) => q.sql.trim())).toContain("ROLLBACK");
    expect(fake.getReleased()).toBe(fake.getConnections());
  });

  it("uses Postgres GREATEST/LEAST in callMsThisMonth instead of SQLite scalar MAX/MIN", async () => {
    const fake = makeFakePgPool({ initialVersion: PG_MIGRATIONS.length });
    const db = await createPgDbFromPool(fake.pool, PG_MIGRATIONS);
    const ms = await callMsThisMonth(db, Date.UTC(2026, 10, 15));
    expect(ms).toBe(12345);
    expect(fake.poolQueries[0]!.sql).toContain("GREATEST");
    expect(fake.poolQueries[0]!.sql).toContain("LEAST");
    expect(fake.poolQueries[0]!.sql).not.toMatch(/\bMAX\(/);
    expect(fake.poolQueries[0]!.sql).not.toMatch(/\bMIN\(/);
  });

  it("keeps :memory: databases on SQLite even if DATABASE_URL is set in env", async () => {
    process.env.DATABASE_URL = "postgresql://postgres:wrong@127.0.0.1:1/nonexistent";
    const db = await openDatabase(":memory:");
    expect(db.dialect).toBe("sqlite");
    await db.close();
  });
});

describe("web panel auto-login & access link", () => {
  it("serves panel with #token= auto-login, access-link copy button, and network-first service worker", async () => {
    const b = await setup();
    try {
      const html = await b.app.inject({ url: "/panel/" });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain('id="copy-access-link"');

      const js = await b.app.inject({ url: "/panel/app.js" });
      expect(js.statusCode).toBe(200);
      expect(js.body).toContain("readHashAuth");
      expect(js.body).toContain("history.replaceState");
      expect(js.body).toContain("buildAccessLink");

      const sw = await b.app.inject({ url: "/panel/sw.js" });
      expect(sw.statusCode).toBe(200);
      expect(sw.body).toContain("securitypay-panel-v2");
    } finally {
      await b.app.close();
    }
  });
});
