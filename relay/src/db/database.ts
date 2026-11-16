import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

export type Db = {
  dialect: "sqlite" | "postgres";
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
};

export interface Statement {
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
}

export type RunResult = { changes: number; lastInsertRowid?: number | bigint };

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
  async get(...params: any[]) { return this.stmt.get(...params); }
  async all(...params: any[]) { return this.stmt.all(...params) as unknown[]; }
  async run(...params: any[]) {
    const r = this.stmt.run(...params) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: r.changes ?? 0, lastInsertRowid: r.lastInsertRowid };
  }
}

class SqliteDb implements Db {
  dialect = "sqlite" as const;
  constructor(private db: DatabaseSync) {}
  prepare(sql: string): Statement { return new SqliteStatement(this.db.prepare(sql)); }
  async exec(sql: string): Promise<void> { this.db.exec(sql); }
  async close(): Promise<void> { this.db.close(); }
}

// ---------- Postgres ----------

function toPg(sql: string): string {
  let out = "";
  let i = 1;
  let inSingle = false;
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c];
    if (ch === "'") { inSingle = !inSingle; out += ch; }
    else if (!inSingle && ch === "?") { out += `$${i++}`; }
    else out += ch;
  }
  return out;
}

class PgStatement implements Statement {
  constructor(private pool: any, private sql: string) {}
  async get(...params: unknown[]) {
    const r = await this.pool.query(toPg(this.sql), params);
    return r.rows[0];
  }
  async all(...params: unknown[]) {
    const r = await this.pool.query(toPg(this.sql), params);
    return r.rows;
  }
  async run(...params: unknown[]) {
    const r = await this.pool.query(toPg(this.sql), params);
    return { changes: r.rowCount ?? 0 };
  }
}

class PgDb implements Db {
  dialect = "postgres" as const;
  constructor(private pool: any) {}
  prepare(sql: string): Statement { return new PgStatement(this.pool, sql); }
  async exec(sql: string): Promise<void> { await this.pool.query(sql); }
  async close(): Promise<void> { await this.pool.end(); }
}

async function runPgMigrations(pool: any, migrations: string[]): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const r = await pool.query("SELECT version FROM schema_version");
  let version = r.rows[0]?.version ?? 0;
  if (r.rows.length === 0) await pool.query("INSERT INTO schema_version (version) VALUES (0)");
  for (; version < migrations.length; version++) {
    await pool.query("BEGIN");
    try {
      await pool.query(migrations[version]!);
      await pool.query("UPDATE schema_version SET version = $1", [version + 1]);
      await pool.query("COMMIT");
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  }
}

export async function openDatabase(path: string, migrations: string[] = SQLITE_MIGRATIONS): Promise<Db> {
  const url =
    process.env.DATABASE_URL ||
    process.env.SECURITYPAY_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.SUPABASE_DB_URL;
  if (url) {
    const pg = await import("pg");
    const pool = new (pg as any).Pool({ connectionString: url });
    try {
      (pg as any).types?.setTypeParser?.(20, (v: string | null) => (v === null ? null : Number(v)));
    } catch {}
    const mig = migrations === SQLITE_MIGRATIONS ? PG_MIGRATIONS : PG_MIGRATIONS;
    await runPgMigrations(pool, mig);
    return new PgDb(pool);
  }
  const db = openSqliteDatabase(path, migrations);
  return new SqliteDb(db);
}

export function getMeta(db: Db, key: string): Promise<string | undefined> {
  return (async () => {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  })();
}

export function setMeta(db: Db, key: string, value: string): Promise<void> {
  return (async () => {
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  })();
}

export async function metaOrInit(db: Db, key: string, make: () => string): Promise<string> {
  const existing = await getMeta(db, key);
  if (existing !== undefined) return existing;
  const v = make();
  await setMeta(db, key, v);
  return v;
}

export { SQLITE_MIGRATIONS, PG_MIGRATIONS };