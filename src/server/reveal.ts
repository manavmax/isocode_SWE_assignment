/**
 * Borrower-phone reveal (SPEC 16, prompt 10a item 5): officer only, an
 * assigned loan only, inside the 08:00-19:00 IST window by SERVER time —
 * the device is never asked for the verdict. Rate limit: 30 reveals per
 * officer per hour, counted in the login_attempt table like the login
 * throttle (A56: one table, generic fixed-window counter, prefixed keys).
 * Every allowed reveal writes one audit_log row; the row carries no phone
 * data (PII scrub).This is the only path that answers an unmasked number.
 */
import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { auditLog, loans, loginAttempts } from './db/schema.js';
import { isWithinContactWindow } from '../shared/contactWindow.js';
import { incrementFixedWindow, windowDecision } from './rateLimit.js';
import type { Actor } from './dal.js';

export const REVEALS_PER_WINDOW = 30;
export const REVEAL_WINDOW_MS = 60 * 60_000;
/** The shared counter table keys login rows as `<username>|<ip>`; the
 * prefixed namespace keeps reveal counters disjoint (A56). */
export function revealThrottleKey(officerId: string): string {
  return `reveal|${officerId}`;
}

export type RevealOutcome =
  | { ok: true; mobile: string | null; altMobile: string | null }
  | { ok: false; code: 404 | 403 | 429; error: string; retryAfterMs?: number };

/** Reads the shared counter row (login_attempt table, prefixed key). */
export async function findRevealCounterRow(key: string): Promise<{ failCount: number; windowStart: Date } | null> {
  const db = getDb();
  const rows = await db
    .select({ failCount: loginAttempts.failCount, windowStart: loginAttempts.windowStart })
    .from(loginAttempts)
    .where(eq(loginAttempts.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function revealBorrowerPhone(
  actor: Actor & { officerId: string },
  loanId: string,
  nowMs: number
): Promise<RevealOutcome> {
  const db = getDb();
  const loanRows = await db
    .select({
      loanId: loans.loanId,
      assignedOfficerId: loans.assignedOfficerId,
      mobile: loans.mobile,
      altMobile: loans.altMobile
    })
    .from(loans)
    .where(eq(loans.loanId, loanId))
    .limit(1);
  const loan = loanRows[0];

  // Authorization before availability: a loan this officer does not hold
  // answers the same generic 404 as a missing one, window open or not (A33).
  if (!loan || loan.assignedOfficerId !== actor.officerId) {
    return { ok: false, code: 404, error: 'not found' };
  }

  // The contact-window gate runs on SERVER time (SPEC 16: reveal is
  // in-window) — the device clock is never consulted for this decision.
  if (!isWithinContactWindow(nowMs)) {
    return {
      ok: false,
      code: 403,
      error: 'phone reveal is allowed only inside the 08:00-19:00 IST contact window'
    };
  }

  const key = revealThrottleKey(actor.officerId);
  const counter = await findRevealCounterRow(key);
  const decision = windowDecision(counter, nowMs, REVEAL_WINDOW_MS, REVEALS_PER_WINDOW);
  if (decision.blocked) {
    return {
      ok: false,
      code: 429,
      error: 'phone reveal limit reached (30 per officer per hour); try again later',
      retryAfterMs: decision.retryAfterMs
    };
  }

  // Count the reveal BEFORE answering, so a count is never lost to a crash
  // after the response left (ordering matters more than the failed-write
  // edge case: a lost increment weakens the limiter by at most one).
  await incrementFixedWindow(key, nowMs, REVEAL_WINDOW_MS);
  await db.insert(auditLog).values({
    actor: actor.username,
    action: 'phone_reveal',
    subject: loanId,
    detail: { officerId: actor.officerId }
  });

  return { ok: true, mobile: loan.mobile, altMobile: loan.altMobile };
}
