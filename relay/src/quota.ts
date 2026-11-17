import type { Db } from "./db/database.js";
import { ApiError, quotaExceeded } from "./errors.js";

/**
 * Per-tenant limits (hub mode, docs/cloud.md). `null` = unlimited. A self-hosted
 * relay has no limits.
 */
export interface Limits {
  max_devices: number | null;
  call_seconds_per_month: number | null;
  messages_per_day: number | null;
}

export const UNLIMITED: Limits = { max_devices: null, call_seconds_per_month: null, messages_per_day: null };

export interface Usage {
  /** UTC calendar month, e.g. "2026-11". */
  month: string;
  call_seconds: number;
  calls: number;
  messages_today: number;
  devices: number;
}

export function monthStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function dayStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Answered call time this UTC month, in ms: each call clipped to [month start, now], so
 * an active call counts up to now and a call that started last month counts only its
 * part in this month.
 */
export async function callMsThisMonth(db: Db, now = Date.now()): Promise<number> {
  const start = monthStart(now);
  const sql =
    db.dialect === "postgres"
      ? `SELECT COALESCE(SUM(GREATEST(0, LEAST(COALESCE(ended_at, CAST(? AS BIGINT)), CAST(? AS BIGINT)) - GREATEST(answered_at, CAST(? AS BIGINT)))), 0) AS ms
         FROM calls WHERE answered_at IS NOT NULL AND COALESCE(ended_at, CAST(? AS BIGINT)) > CAST(? AS BIGINT)`
      : `SELECT COALESCE(SUM(MAX(0, MIN(COALESCE(ended_at, ?), ?) - MAX(answered_at, ?))), 0) AS ms
         FROM calls WHERE answered_at IS NOT NULL AND COALESCE(ended_at, ?) > ?`;
  const r = (await db.prepare(sql).get(now, now, start, now, start)) as { ms: number };
  return Number(r.ms);
}

async function count(db: Db, sql: string, ...args: number[]): Promise<number> {
  return Number((await db.prepare(sql).get(...args) as { n: number }).n);
}

const activeDevices = async (db: Db) => count(db, "SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL");
const messagesToday = async (db: Db, now: number) =>
  count(db, "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?", dayStart(now));

export async function usage(db: Db, now = Date.now()): Promise<Usage> {
  const d = new Date(now);
  return {
    month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    call_seconds: Math.floor((await callMsThisMonth(db, now)) / 1000),
    calls: await count(db, "SELECT COUNT(*) AS n FROM calls WHERE created_at >= ?", monthStart(now)),
    messages_today: await messagesToday(db, now),
    devices: await activeDevices(db),
  };
}

export async function checkPair(db: Db, limits: Limits): Promise<void> {
  if (limits.max_devices !== null && (await activeDevices(db)) >= limits.max_devices) {
    throw quotaExceeded(`Your plan allows ${limits.max_devices} paired phone(s); unpair one first`);
  }
}

export async function checkMessage(db: Db, limits: Limits): Promise<void> {
  if (limits.messages_per_day !== null && (await messagesToday(db, Date.now())) >= limits.messages_per_day) {
    throw quotaExceeded(`Your plan allows ${limits.messages_per_day} messages per day`);
  }
}

/** Call time left this month in ms, or undefined when unlimited. */
export async function callMsLeft(db: Db, limits: Limits): Promise<number | undefined> {
  if (limits.call_seconds_per_month === null) return undefined;
  return Math.max(0, limits.call_seconds_per_month * 1000 - (await callMsThisMonth(db)));
}

/**
 * Unanswered calls per hour on a plan with a call-time limit. Only answered time counts
 * against that limit, so without this a tenant could ring and cancel for free, and hold
 * shared voice slots while ringing. A self-hosted relay has no limit.
 */
export const UNANSWERED_CALLS_PER_HOUR = 20;

export async function checkCallRate(db: Db, limits: Limits, now = Date.now()): Promise<void> {
  if (limits.call_seconds_per_month === null) return;
  const n = await count(db, "SELECT COUNT(*) AS n FROM calls WHERE created_at >= ? AND answered_at IS NULL", now - 3_600_000);
  if (n >= UNANSWERED_CALLS_PER_HOUR) throw new ApiError(429, "rate_limited", "Too many unanswered calls; try again later");
}

export async function checkCall(db: Db, limits: Limits): Promise<void> {
  const left = await callMsLeft(db, limits);
  if (left !== undefined && left < 1000) {
    throw quotaExceeded(`Your plan's ${Math.round(limits.call_seconds_per_month! / 60)} call minutes for this month are used up`);
  }
}
