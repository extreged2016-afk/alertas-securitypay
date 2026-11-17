import { setDefaultResultOrder } from "node:dns";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient, PoolConfig } from "pg";

const SQLITE_MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE pairing_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT,
    push_secret TEXT NOT NULL,
    fcm_token TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE messages (
    msg_id TEXT PRIMARY KEY,
    sender TEXT NOT NULL CHECK (sender IN ('agent','user')),
    text TEXT NOT NULL,
    reply_to TEXT,
    client_msg_id TEXT,
    device_id TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE UNIQUE INDEX messages_client_id ON messages(sender, client_msg_id) WHERE client_msg_id IS NOT NULL;
  CREATE INDEX messages_created ON messages(created_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE calls (
    call_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('agent_to_user','user_to_agent')),
    state TEXT NOT NULL CHECK (state IN ('ringing','active','ended','missed','declined','canceled')),
    reason TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('normal','urgent')),
    agent_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER,
    ended_by TEXT,
    end_reason TEXT,
    device_id TEXT
  );
  CREATE INDEX calls_open ON calls(state) WHERE state IN ('ringing','active');
  `,
  `
  CREATE TABLE call_participants (
    call_id TEXT NOT NULL REFERENCES calls(call_id),
    device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ringing','joined','declined','missed','left')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (call_id, device_id)
  );
  `,
  `
  ALTER TABLE calls ADD COLUMN device_ids TEXT;
  `,
  `
  CREATE TABLE alerts (
    alert_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','critical')),
    source TEXT NOT NULL,
    data TEXT,
    voice_room TEXT,
    tts_text TEXT,
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    acked_by TEXT
  );
  CREATE INDEX alerts_created ON alerts(created_at DESC);
  CREATE INDEX alerts_open ON alerts(priority) WHERE acked_at IS NULL;
  `,
];

const PG_MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS pairing_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    used_at BIGINT,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT,
    push_secret TEXT NOT NULL,
    fcm_token TEXT,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT,
    revoked_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS messages (
    msg_id TEXT PRIMARY KEY,
    sender TEXT NOT NULL CHECK (sender IN ('agent','user')),
    text TEXT NOT NULL,
    reply_to TEXT,
    client_msg_id TEXT,
    device_id TEXT,
    created_at BIGINT NOT NULL,
    read_at BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(sender, client_msg_id) WHERE client_msg_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS events (
    seq SERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    ts BIGINT NOT NULL,
    body TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS calls (
    call_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('agent_to_user','user_to_agent')),
    state TEXT NOT NULL CHECK (state IN ('ringing','active','ended','missed','declined','canceled')),
    reason TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('normal','urgent')),
    agent_name TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    answered_at BIGINT,
    ended_at BIGINT,
    ended_by TEXT,
    end_reason TEXT,
    device_id TEXT
  );
  CREATE INDEX IF NOT EXISTS calls_open ON calls(state) WHERE state IN ('ringing','active');
  `,
  `
  CREATE TABLE IF NOT EXISTS call_participants (
    call_id TEXT NOT NULL REFERENCES calls(call_id),
    device_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ringing','joined','declined','missed','left')),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (call_id, device_id)
  );
  `,
  `
  ALTER TABLE calls ADD COLUMN IF NOT EXISTS device_ids TEXT;
  `,
  `
  CREATE TABLE IF NOT EXISTS alerts (
    alert_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','critical')),
    source TEXT NOT NULL,
    data TEXT,
    voice_room TEXT,
    tts_text TEXT,
    created_at BIGINT NOT NULL,
    acked_at BIGINT,
    acked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS alerts_created ON alerts(created_at DESC);
  CREATE INDEX IF NOT EXISTS alerts_open ON alerts(priority) WHERE acked_at IS NULL;
  `,
];

export const MIGRATIONS = SQLITE_MIGRATIONS;

/** Advisory lock key for serializing concurrent Postgres schema migrations (e.g. rolling deploys). */
const PG_MIGRATION_LOCK_KEY = 739182645;

export type Db = {
  dialect: "sqlite" | "postgres";
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export interface Statement {
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export type RunResult = { changes: number; lastInsertRowid?: number | bigint };

export interface OpenDatabaseOptions {
  /** Always open SQLite even if DATABASE_URL is set (used for in-memory tests and isolated hub tenants). */
  forceSqlite?: boolean;
}

// ---------- SQLite (sync, wrapped async) ----------

export function openSqliteDatabase(path: string, migrations: string[] = SQLITE_MIGRATIONS): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  for (; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[version]!);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

class SqliteStatement implements Statement {
  constructor(private stmt: ReturnType<DatabaseSync["prepare"]>) {}
  async get(...params: any[]) {
    return this.stmt.get(...params);
  }
  async all(...params: any[]) {
    return this.stmt.all(...params) as unknown[];
  }
  async run(...params: any[]) {
    const r = this.stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: r.changes ?? 0, lastInsertRowid: r.lastInsertRowid };
  }
}

class SqliteDb implements Db {
  dialect = "sqlite" as const;
  private spSeq = 0;

  constructor(private db: DatabaseSync) {}
  prepare(sql: string): Statement {
    return new SqliteStatement(this.db.prepare(sql));
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const sp = `sp_${++this.spSeq}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      this.db.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${sp}`);
      this.db.exec(`RELEASE ${sp}`);
      throw err;
    }
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------- Postgres ----------

export function toPg(sql: string): string {
  let out = "";
  let i = 1;
  let inSingle = false;
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c];
    if (ch === "'") {
      inSingle = !inSingle;
      out += ch;
    } else if (!inSingle && ch === "?") {
      out += `$${i++}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export interface PgConnectionMeta {
  host: string;
  port: number;
  database: string;
  user?: string;
  sslEnabled: boolean;
  passwordLooksBracketed: boolean;
  passwordLooksPlaceholder: boolean;
  isSupabasePooler: boolean;
  isSupabaseDirect: boolean;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses a PostgreSQL connection URL into an explicit `PoolConfig` without
 * delegating SSL to `pg-connection-string` (which ignores `PoolConfig.ssl` when
 * `connectionString` is present and treats `sslmode=require` as strict CA check,
 * breaking Supabase's connection pooler).
 */
export function parsePgConnectionConfig(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { config: PoolConfig; meta: PgConnectionMeta } {
  let cleaned = rawUrl.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!/^postgres(?:ql)?:\/\//i.test(cleaned)) {
    throw new Error("DATABASE_URL must start with postgresql:// or postgres://");
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid PostgreSQL URL. If your password has special characters (#, ?, /, %, @), URL-encode them or set DATABASE_PASSWORD separately.",
    );
  }

  const host = parsed.hostname.replace(/^\[(.+)\]$/, "$1");
  if (!host) {
    throw new Error(
      "DATABASE_URL is missing a hostname. If your password contains '#' or '?', URL-encode it or set DATABASE_PASSWORD separately.",
    );
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`DATABASE_URL has an invalid port: ${parsed.port}`);
  }
  const database = safeDecode(parsed.pathname.replace(/^\//, "")) || "postgres";
  const user = parsed.username ? safeDecode(parsed.username) : undefined;
  const urlPassword = parsed.password !== "" ? safeDecode(parsed.password) : undefined;
  const envPassword = env.DATABASE_PASSWORD && env.DATABASE_PASSWORD.length > 0 ? env.DATABASE_PASSWORD : undefined;
  const password = envPassword ?? urlPassword;

  const sslmode = (parsed.searchParams.get("sslmode") || env.PGSSLMODE || "").toLowerCase();
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("/");
  const strictSsl =
    env.DATABASE_SSL_REJECT_UNAUTHORIZED === "1" || env.DATABASE_SSL_REJECT_UNAUTHORIZED === "true";

  let ssl: PoolConfig["ssl"];
  if (sslmode === "disable" || env.DATABASE_SSL === "0" || env.DATABASE_SSL === "false") {
    ssl = false;
  } else if (sslmode === "verify-full" || strictSsl) {
    ssl = { rejectUnauthorized: true };
  } else if (sslmode === "verify-ca") {
    ssl = { rejectUnauthorized: true, checkServerIdentity: () => undefined };
  } else if (!isLocal || sslmode === "require" || sslmode === "prefer" || sslmode === "no-verify" || env.DATABASE_SSL === "1") {
    ssl = { rejectUnauthorized: false };
  } else {
    ssl = false;
  }

  const poolMax = Number(env.DATABASE_POOL_MAX || "10");
  const config: PoolConfig = {
    host,
    port,
    database,
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
    ssl,
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: "securitypay-relay",
  };

  const lowerHost = host.toLowerCase();
  const meta: PgConnectionMeta = {
    host,
    port,
    database,
    user,
    sslEnabled: Boolean(ssl),
    passwordLooksBracketed: Boolean(password && /^\[.+\]$/.test(password)),
    passwordLooksPlaceholder: Boolean(
      password && /your[-_ ]?password|tu[-_ ]?password|password_here/i.test(password),
    ),
    isSupabasePooler: lowerHost.endsWith(".pooler.supabase.com"),
    isSupabaseDirect: /^db\.[a-z0-9-]+\.supabase\.co$/i.test(lowerHost),
  };

  return { config, meta };
}

/**
 * Formats a secret-free diagnostic startup error for Postgres connection/auth failures.
 * Never includes the password or raw DATABASE_URL.
 */
export function formatPgStartupError(err: unknown, meta: PgConnectionMeta): Error {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const msg = e?.message ?? String(err);
  const target = `host=${meta.host}:${meta.port} user=${meta.user ?? "(none)"} db=${meta.database} ssl=${meta.sslEnabled ? "on" : "off"}`;

  const hints: string[] = [];
  if (code === "28P01" || /password authentication failed/i.test(msg)) {
    if (meta.passwordLooksPlaceholder) {
      hints.push("The password in DATABASE_URL still looks like a placeholder ([YOUR-PASSWORD] / [TU-PASSWORD]). Replace it with your actual database password.");
    } else if (meta.passwordLooksBracketed) {
      hints.push("The password in DATABASE_URL is wrapped in square brackets [...]. Remove the '[' and ']' characters around your password.");
    }
    if (meta.isSupabasePooler && meta.user === "postgres") {
      hints.push("Supabase Connection Pooler requires username 'postgres.<project-ref>', not bare 'postgres'. Copy the exact URI from Supabase -> Connect -> Pooler.");
    }
    hints.push(
      "Verify or reset the database password in Supabase (Settings -> Database -> Reset database password). If the password contains special characters (@, #, :, /, %, ?, &), URL-encode them or set DATABASE_PASSWORD as a separate environment variable.",
    );
  } else if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    if (meta.isSupabaseDirect) {
      hints.push("Direct Supabase hosts (db.<ref>.supabase.co:5432) use IPv6, which Render cannot reach. Switch DATABASE_URL to the Supabase Connection Pooler URI (aws-0-<region>.pooler.supabase.com:6543 or :5432) with user 'postgres.<project-ref>'.");
    } else {
      hints.push("Network unreachable when connecting to Postgres. Verify the host supports IPv4 from Render.");
    }
  } else if (code === "XX000" && /tenant or user not found/i.test(msg)) {
    hints.push("Supabase Pooler rejected the tenant/user. Make sure the username is 'postgres.<project-ref>' and the pooler region host matches your Supabase project.");
  }

  const detail = hints.length > 0 ? ` Hints: ${hints.join(" ")}` : "";
  return new Error(`PostgreSQL connection failed (${target}): ${msg}.${detail}`, { cause: err });
}

interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

class PgStatement implements Statement {
  constructor(
    private queryable: PgQueryable,
    private sql: string,
  ) {}
  async get(...params: unknown[]) {
    const r = await this.queryable.query(toPg(this.sql), params);
    return r.rows[0];
  }
  async all(...params: unknown[]) {
    const r = await this.queryable.query(toPg(this.sql), params);
    return r.rows;
  }
  async run(...params: unknown[]) {
    const r = await this.queryable.query(toPg(this.sql), params);
    return { changes: r.rowCount ?? 0 };
  }
}

class PgClientDb implements Db {
  dialect = "postgres" as const;
  private spSeq = 0;

  constructor(private client: PgQueryable) {}
  prepare(sql: string): Statement {
    return new PgStatement(this.client, sql);
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const sp = `sp_${++this.spSeq}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => undefined);
      throw err;
    }
  }
  async close(): Promise<void> {
    // Lifecycle managed by the outer transaction.
  }
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
  end(): Promise<void>;
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

class PgDb implements Db {
  dialect = "postgres" as const;
  constructor(private pool: PgPoolLike) {}
  prepare(sql: string): Statement {
    return new PgStatement(this.pool, sql);
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PgClientDb(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function runPgMigrations(
  pool: Pick<PgPoolLike, "connect">,
  migrations: string[] = PG_MIGRATIONS,
): Promise<void> {
  const client = await pool.connect();
  try {
    // Transaction-scoped advisory lock: safe under PgBouncer transaction pooling (port 6543)
    // and prevents races when two instances boot during a rolling deploy.
    await client.query("BEGIN");
    try {
      await client.query(`SELECT pg_advisory_xact_lock(${PG_MIGRATION_LOCK_KEY})`);
      await client.query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
      const init = await client.query("SELECT version FROM schema_version");
      if (init.rows.length === 0) {
        await client.query("INSERT INTO schema_version (version) VALUES (0)");
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    for (let target = 1; target <= migrations.length; target++) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT pg_advisory_xact_lock(${PG_MIGRATION_LOCK_KEY})`);
        const cur = await client.query("SELECT version FROM schema_version");
        const version = Number(cur.rows[0]?.version ?? 0);
        if (version < target) {
          await client.query(migrations[target - 1]!);
          await client.query("UPDATE schema_version SET version = $1", [target]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

/** Creates a Postgres-backed Db from an existing pool (also used in tests). */
export async function createPgDbFromPool(pool: PgPoolLike, migrations: string[] = PG_MIGRATIONS): Promise<Db> {
  await runPgMigrations(pool, migrations);
  return new PgDb(pool);
}

export async function openDatabase(
  path: string,
  migrations: string[] = SQLITE_MIGRATIONS,
  opts: OpenDatabaseOptions = {},
): Promise<Db> {
  const url =
    opts.forceSqlite || path === ":memory:"
      ? undefined
      : process.env.DATABASE_URL ||
        process.env.SECURITYPAY_DATABASE_URL ||
        process.env.POSTGRES_URL ||
        process.env.SUPABASE_DB_URL;

  if (url) {
    // Prefer IPv4 on dual-stack hosts so Render containers don't fail with ENETUNREACH on IPv6.
    try {
      setDefaultResultOrder("ipv4first");
    } catch {
      // ignore if unsupported
    }

    const { config, meta } = parsePgConnectionConfig(url, process.env);
    const pg = await import("pg");
    const pgTypes = pg.types ?? pg.default?.types;
    try {
      // Parse PostgreSQL int8 (BIGINT / COUNT(*), OID 20) as JS numbers for parity with SQLite.
      pgTypes?.setTypeParser?.(20, (v: string) => Number(v));
    } catch {
      // ignore if parser override fails
    }

    const PoolCtor = pg.Pool ?? pg.default?.Pool;
    const pool: Pool = new PoolCtor(config);
    // Prevent idle disconnects from Supabase/PgBouncer from crashing the process.
    pool.on("error", (err) => {
      console.error(`[db] idle postgres client error (${meta.host}:${meta.port}):`, err.message);
    });

    try {
      const mig = migrations === SQLITE_MIGRATIONS ? PG_MIGRATIONS : migrations;
      await runPgMigrations(pool, mig);
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw formatPgStartupError(err, meta);
    }
    return new PgDb(pool);
  }

  const db = openSqliteDatabase(path, migrations);
  return new SqliteDb(db);
}

export async function getMeta(db: Db, key: string): Promise<string | undefined> {
  const row = (await db.prepare("SELECT value FROM meta WHERE key = ?").get(key)) as { value: string } | undefined;
  return row?.value;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export async function metaOrInit(db: Db, key: string, make: () => string): Promise<string> {
  const existing = await getMeta(db, key);
  if (existing !== undefined) return existing;
  const v = make();
  await setMeta(db, key, v);
  return v;
}

export { SQLITE_MIGRATIONS, PG_MIGRATIONS };
