/**
 * Server-side auth session (ADR-0005): DB session rows + an HttpOnly Secure
 * SameSite=Lax cookie. The cookie carries the raw random token; the database
 * stores only its sha256, so a DB leak cannot mint sessions. 7-day expiry
 * (A30) is enforced at lookup time, so an expired row is rejected even before
 * the browser drops its cookie. All rules here are DB + crypto plumbing; the
 * parameter numbers live in docs/assumptions.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { sessions, users } from './db/schema.js';
import type { Actor } from './dal.js';

export const SESSION_COOKIE = 'fc_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(userId: string, now: Date = new Date()): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const db = getDb();
  await db.insert(sessions).values({ userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt };
}

/** Cookie settings for hono's setCookie(): HttpOnly Secure SameSite=Lax (A30). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: maxAgeSeconds } as const;
}

/** Pure timing rule, so the expired-session behaviour is testable offline. */
export function isSessionActive(session: { expiresAt: Date }, atMs: number): boolean {
  return session.expiresAt.getTime() > atMs;
}

export async function resolveSessionActor(token: string | null | undefined): Promise<Actor | null> {
  if (!token) {
    return null;
  }
  const db = getDb();
  const rows = await db
    .select({
      userId: users.id,
      username: users.username,
      role: users.role,
      branchId: users.branchId,
      officerId: users.officerId,
      active: users.active,
      expiresAt: sessions.expiresAt
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.active || !isSessionActive({ expiresAt: row.expiresAt }, Date.now())) {
    return null;
  }
  return { userId: row.userId, username: row.username, role: row.role, branchId: row.branchId, officerId: row.officerId ?? null, active: row.active };
}

/** Idempotent logout: removes the DB row so the token cannot be reused. The
 * cookie itself is cleared by the route. */
export async function revokeSession(token: string | null | undefined): Promise<void> {
  if (!token) {
    return;
  }
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}
