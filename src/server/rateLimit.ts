/**
 * Login rate limit (A30): 5 failed attempts per 15-minute window, keyed by
 * username + client IP. The counter lives in the `login_attempt` table, not
 * in process memory — an in-process Map resets with every serverless
 * invocation and is not shared across instances, so it would enforce nothing
 * on Vercel. The window rules stay pure (injectable clock) and the DB write
 * for a failure is a single atomic upsert, so the read-modify-write race is
 * answered by the database. A successful login deletes the row.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { loginAttempts } from './db/schema.js';

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_WINDOW = 5;

export interface LoginThrottle {
  blocked: boolean;
  /** Seconds of Retry-After (≥1 when blocked, 0 when open). */
  retryAfterMs: number;
  failures: number;
}

export interface AttemptRow {
  failCount: number;
  windowStart: Date;
}

/** A30: the key is username + client IP, so lockouts do not cross accounts
 * or IPs. Routes compose it through this helper so the rule stays one place. */
export function loginThrottleKey(username: string, clientIp: string): string {
  return `${username}|${clientIp}`;
}

/** Pure window math: a row whose window has expired is treated as absent and
 * the next recorded failure opens a fresh window (DB does the rollover). */
export function throttleDecision(row: AttemptRow | null | undefined, nowMs: number): LoginThrottle {
  if (!row || nowMs - row.windowStart.getTime() >= LOGIN_WINDOW_MS) {
    return { blocked: false, retryAfterMs: 0, failures: 0 };
  }
  const blocked = row.failCount >= MAX_FAILURES_PER_WINDOW;
  return {
    blocked,
    retryAfterMs: blocked ? Math.max(1, Math.ceil(row.windowStart.getTime() + LOGIN_WINDOW_MS - nowMs)) : 0,
    failures: row.failCount
  };
}

export async function findLoginAttempts(key: string): Promise<AttemptRow | null> {
  const db = getDb();
  const rows = await db
    .select({ failCount: loginAttempts.failCount, windowStart: loginAttempts.windowStart })
    .from(loginAttempts)
    .where(eq(loginAttempts.key, key))
    .limit(1);
  return rows[0] ?? null;
}

/** One roundtrip: insert the key at count 1, or — when the key already
 * exists — start a fresh window with count 1 if the old window expired,
 * otherwise increment. In the conflict update, the table-qualified columns
 * read the existing row (Postgres ON CONFLICT semantics). */
export async function recordLoginFailure(key: string, nowMs: number): Promise<void> {
  const db = getDb();
  const cutoff = new Date(nowMs - LOGIN_WINDOW_MS).toISOString();
  const now = new Date(nowMs).toISOString();
  await db
    .insert(loginAttempts)
    .values({ key, failCount: 1, windowStart: new Date(nowMs) })
    .onConflictDoUpdate({
      target: loginAttempts.key,
      set: {
        failCount: sql`case when ${loginAttempts.windowStart} <= ${cutoff}::timestamptz then 1 else ${loginAttempts.failCount} + 1 end`,
        windowStart: sql`case when ${loginAttempts.windowStart} <= ${cutoff}::timestamptz then ${now}::timestamptz else ${loginAttempts.windowStart} end`
      }
    });
}

export async function clearLoginFailures(key: string): Promise<void> {
  const db = getDb();
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}
