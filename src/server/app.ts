import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { applyImport } from './import/applyImport.js';
import { validateAsOf, validateUploadFile } from './import/uploadMeta.js';
import { buildErrorsCsv } from './errorsCsv.js';
import { fetchBatchWithRowErrors, fetchLoanForActor, findLoginUser, isManager, listOfficerAssignments, probeDb } from './dal.js';
import { verifyPassword } from './auth.js';
import {
  createSession,
  resolveSessionActor,
  revokeSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  SESSION_TTL_MS
} from './sessions.js';
import { clearLoginFailures, findLoginAttempts, loginThrottleKey, recordLoginFailure, throttleDecision } from './rateLimit.js';
import { processEventBatch } from './events.js';
import { revealBorrowerPhone } from './reveal.js';
import { contactEventBatchSchema, MAX_EVENT_BATCH } from '../shared/sync/eventSchema.js';
import { demoLoginAllowed, demoModeEnabled } from './demo.js';
import { listDemoUsernames } from './dal.js';

export const app = new Hono();

app.get('/api/health', async (c) => {
  try {
    await probeDb();
    return c.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch {
    return c.json({ status: 'degraded', db: 'error', time: new Date().toISOString() }, 503);
  }
});

/** Cookie sessions only — one auth mechanism, one attack surface. The Basic
 * header path was scaffolding for import-check and retired with it: scripts
 * now log in through POST /api/auth/login exactly like the UI does. A stray
 * Authorization header is simply not an identity. */

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

app.post('/api/auth/login', async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    const username = typeof (body as { username?: unknown })?.username === 'string' ? ((body as { username: string }).username) : '';
    const pin = typeof (body as { pin?: unknown })?.pin === 'string' ? ((body as { pin: string }).pin) : '';
    if (username.length === 0 || pin.length === 0) {
      return c.json({ error: 'username and pin are required' }, 400);
    }

    // A30: throttle per username + client IP before any password work; the
    // counter lives in the login_attempt table so it holds across instances.
    const throttleKey = loginThrottleKey(username, clientIp(c));
    const now = Date.now();
    const throttle = throttleDecision(await findLoginAttempts(throttleKey), now);
    if (throttle.blocked) {
      return c.json({ error: 'too many login attempts; try again later' }, 429, {
        'Retry-After': String(Math.ceil(throttle.retryAfterMs / 1000))
      });
    }

    // Failed attempt = unknown user, inactive row, demo account with the
    // off-switch set, or a wrong PIN — same generic text and same failure
    // record for all of them, so nothing is enumerable (A30/A31).
    const user = await findLoginUser(username);
    if (!user || !user.active || !demoLoginAllowed(user.isDemo, demoModeEnabled()) || !verifyPassword(user.passwordHash, pin)) {
      await recordLoginFailure(throttleKey, now);
      return c.json({ error: 'wrong username or PIN' }, 401);
    }

    const session = await createSession(user.id);
    setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(Math.ceil(SESSION_TTL_MS / 1000)));
    await clearLoginFailures(throttleKey);
    return c.json({ user: { username: user.username, role: user.role, branchId: user.branchId, officerId: user.officerId ?? null } });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

app.post('/api/auth/logout', async (c) => {
  try {
    await revokeSession(getCookie(c, SESSION_COOKIE));
    setCookie(c, SESSION_COOKIE, '', sessionCookieOptions(0));
    return c.json({ ok: true });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

/** SPEC 2/16: demo chips exist only while DEMO_MODE is on. The endpoint is
 * public (login screen has no session yet) but returns usernames only — no
 * roles, ids or presence of real accounts — and an empty list (not an error)
 * when the switch is off. */
app.get('/api/demo-accounts', async (c) => {
  try {
    if (!demoModeEnabled()) {
      return c.json({ usernames: [] });
    }
    const usernames = await listDemoUsernames();
    return c.json({ usernames });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

app.get('/api/me', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ user: { username: actor.username, role: actor.role, branchId: actor.branchId, officerId: actor.officerId } });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

/** A33: the officer's own overdue worklist, phones already masked by the
 * data-access layer. Managers are refused: assignments are officer-scoped. */
app.get('/api/me/assignments', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (actor.role !== 'field_officer' || !actor.officerId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const assignments = await listOfficerAssignments(actor);
    return c.json({ assignments });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

/** A33: one loan detail per session actor. Officer: only their assignment;
 * manager: only their branch. Every invisible loan answers the same generic
 * 404 as a missing loan, and the payload carries no raw phone numbers. */
app.get('/api/loans/:id', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const loan = await fetchLoanForActor(actor, c.req.param('id'));
    if (!loan) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({ loan });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/api/import', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!isManager(actor)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart form-data with a csv file is required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'a csv file field named "file" is required' }, 400);
    }
    const fileCheck = validateUploadFile(file);
    if (!fileCheck.ok) {
      return c.json({ error: fileCheck.error }, fileCheck.code === 'too_large' ? 413 : 415);
    }
    const asOfField = form.get('as_of');
    const asOfCheck = validateAsOf(asOfField === null ? undefined : String(asOfField));
    if (!asOfCheck.ok) {
      return c.json({ error: asOfCheck.error }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await applyImport({
      bytes,
      filename: file.name,
      asOf: asOfCheck.asOf,
      actor: { userId: actor.userId, username: actor.username }
    });
    if (outcome.status === 'rejected') {
      return c.json({ status: 'rejected', abort: outcome.abort, report: outcome.counts }, 422);
    }
    return c.json({ status: outcome.status, batchId: outcome.batchId, report: outcome.report });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

app.get('/api/import/:id/errors.csv', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!isManager(actor)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'not found' }, 404);
    }
    const found = await fetchBatchWithRowErrors(id);
    if (!found) {
      return c.json({ error: 'not found' }, 404);
    }
    const csv = buildErrorsCsv(found.rows);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="errors_${found.batch.id}.csv"`
      }
    });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

/** SPEC 6: the offline outbox flushes here, batches of 20, always HTTP 200
 * while authenticated so one bad item cannot fail the queue (SPEC 6 answer
 * shape: [{id, status: created|duplicate|rejected, reason}]). The response
 * also carries serverNow for the client's skew estimation. Never retryable
 * failures (4xx-grade) arrive as per-item `rejected` entries. */
app.post('/api/events/batch', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (actor.role !== 'field_officer' || !actor.officerId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    const envelope = contactEventBatchSchema.safeParse(body);
    if (!envelope.success) {
      return c.json({ error: `events must contain 1 to ${MAX_EVENT_BATCH} items` }, 400);
    }
    const outcome = await processEventBatch(
      { ...actor, officerId: actor.officerId },
      envelope.data.events,
      Date.now()
    );
    return c.json(outcome);
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

/** SPEC 16: reveal is officer-only, on an assigned loan, inside the contact
 * window by SERVER time, rate-limited in the DB (A56) and audited. This is
 * the ONLY route that answers an unmasked number; the client may cache it
 * until the end of the IST day (A57). Hono resolves the more specific
 * /reveal-phone path before the :id catch-all above. */
app.post('/api/loans/:id/reveal-phone', async (c) => {
  try {
    const actor = await resolveSessionActor(getCookie(c, SESSION_COOKIE));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (actor.role !== 'field_officer' || !actor.officerId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const outcome = await revealBorrowerPhone(
      { ...actor, officerId: actor.officerId },
      c.req.param('id'),
      Date.now()
    );
    if (!outcome.ok) {
      if (outcome.code === 429 && outcome.retryAfterMs) {
        return c.json({ error: outcome.error }, 429, {
          'Retry-After': String(Math.ceil(outcome.retryAfterMs / 1000))
        });
      }
      return c.json({ error: outcome.error }, outcome.code);
    }
    return c.json({ mobile: outcome.mobile, altMobile: outcome.altMobile });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});
