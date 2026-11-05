import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { applyImport } from './import/applyImport.js';
import { validateAsOf, validateUploadFile } from './import/uploadMeta.js';
import { buildErrorsCsv } from './errorsCsv.js';
import { fetchBatchWithRowErrors, findLoginUser, isManager, resolveActor } from './dal.js';
import { verifyPassword } from './auth.js';
import {
  createSession,
  resolveSessionActor,
  revokeSession,
  sessionCookieOptions,
  SESSION_COOKIE,
  SESSION_TTL_MS
} from './sessions.js';
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure } from './rateLimit.js';
import { demoLoginAllowed, demoModeEnabled } from './demo.js';

export const app = new Hono();

app.get('/api/health', async (c) => {
  try {
    const db = getDb();
    await db.execute(sql`select 1 as ok`);
    return c.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch {
    return c.json({ status: 'degraded', db: 'error', time: new Date().toISOString() }, 503);
  }
});

/** Cookie session first (the logged-in UI), then the unchanged Basic header
 * (manager CLI / smoke). Session lookups go through sessions.ts, never this
 * file — routes hold no data-access code (guard test). */
async function resolveRequestActor(cookieToken: string | undefined, authorization: string | null | undefined) {
  return (await resolveSessionActor(cookieToken)) ?? (await resolveActor(authorization));
}

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

    // A30: throttle per username + client IP before any password work.
    const throttleKey = `${username}|${clientIp(c)}`;
    const now = Date.now();
    const throttle = checkLoginThrottle(throttleKey, now);
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
      recordLoginFailure(throttleKey, now);
      return c.json({ error: 'wrong username or PIN' }, 401);
    }

    const session = await createSession(user.id);
    setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(Math.ceil(SESSION_TTL_MS / 1000)));
    clearLoginFailures(throttleKey);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/api/import', async (c) => {
  try {
    const actor = await resolveRequestActor(getCookie(c, SESSION_COOKIE), c.req.header('Authorization'));
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
    const actor = await resolveRequestActor(getCookie(c, SESSION_COOKIE), c.req.header('Authorization'));
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
