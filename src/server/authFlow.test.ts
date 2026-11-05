import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './auth.js';

/**
 * Route-level auth tests with NO live database: the db.js driver module is
 * replaced by a fake whose every query-resolution pops one pre-queued result
 * (a row array, or `[]` for "no rows found"). Everything above the driver —
 * rate limiting, scrypt verify, demo gate, cookie flags, session expiry —
 * runs as the real production code.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const sessionsWritten: unknown[] = [];
  const shift = () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('fake db queue empty (a query resolved with no queued result)');
    }
    // Each queued slot normalizes to a RESULT ARRAY: a bare row means one-row
    // result; `[]` means the query legitimately found no rows.
    if (Array.isArray(next)) {
      return next;
    }
    return [next];
  };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    orderBy: () => chain,
    limit: async () => shift(),
    then: (resolve: (rows: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(shift()).then(resolve, reject)
  };
  const fakeDb = {
    select: () => chain,
    insert: () => ({
      values: async (value: unknown) => {
        sessionsWritten.push(value);
        return value;
      }
    }),
    delete: () => ({
      where: async () => {
        sessionsWritten.length = 0;
        return { rowCount: sessionsWritten.length };
      }
    })
  };
  return { queue, sessionsWritten, fakeDb };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPool: () => {
    throw new Error('getPool is not used by auth flow tests');
  },
  getPooledDb: () => h.fakeDb,
  withTx: async () => {
    throw new Error('withTx is not used by auth flow tests');
  },
  closePool: async () => undefined
}));

import { app } from './app.js';
import { checkLoginThrottle, resetLoginThrottleForTests } from './rateLimit.js';
import { hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';
import { DEMO_PIN } from './demo.js';

const NOW = Date.now();
const BRANCH = 'branch-aaaa-aaaa-aaaaaaaaaaaa';
const OFFICER_ID = 'officer-A-000000000000000000000000001';

function fieldOfficerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'user-officer-0000000000000000000000000001',
    username: 'ss-officer',
    passwordHash: hashPassword('pin-7777'),
    role: 'field_officer',
    branchId: BRANCH,
    officerId: OFFICER_ID,
    active: true,
    isDemo: false,
    ...over
  };
}

function managerRow(over: Record<string, unknown> = {}) {
  return fieldOfficerRow({ username: 'ss-manager', role: 'branch_manager', officerId: null, ...over });
}

function sessionRow(over: Record<string, unknown> = {}) {
  const user = fieldOfficerRow();
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    branchId: user.branchId,
    officerId: user.officerId,
    active: true,
    expiresAt: new Date(NOW + 60_000),
    ...over
  };
}

function login(username: string, pin: string, extraHeaders: Record<string, string> = {}) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ username, pin })
  });
}

function cookieFor(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.sessionsWritten.length = 0;
  });
  afterEach(() => {
    resetLoginThrottleForTests();
    delete process.env.DEMO_MODE;
  });

  it('requires a username and pin', async () => {
    h.queue.push(fieldOfficerRow());
    const res = await login('', '');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('username and pin are required');
  });

  it('answers an unknown username with the generic wrong-username-or-PIN message', async () => {
    h.queue.push([]); // select resolves to "no rows"
    const res = await login('nobody', 'pin-7777');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
  });

  it('answers a wrong PIN with the generic message and records the failure (real scrypt verify ran)', async () => {
    h.queue.push(fieldOfficerRow());
    const res = await login('ss-officer', 'pin-0000');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
    expect(checkLoginThrottle('ss-officer|unknown', NOW).failures).toBe(1);
  });

  it('a correct PIN checks the scrypt hash, records a hashed session, and sets an HttpOnly Secure SameSite=Lax 7-day cookie', async () => {
    h.queue.push(fieldOfficerRow());
    const res = await login('ss-officer', 'pin-7777');
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { username: string; role: string; branchId: string; officerId: string | null } };
    expect(body.user).toEqual({ username: 'ss-officer', role: 'field_officer', branchId: BRANCH, officerId: OFFICER_ID });
    const setCookie = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(setCookie).toContain('fc_session=');
    expect(setCookie).toContain('httponly');
    expect(setCookie).toContain('secure');
    expect(setCookie).toContain('samesite=lax');
    expect(setCookie).toContain(`max-age=${SESSION_TTL_MS / 1000}`);
    expect(h.sessionsWritten).toHaveLength(1);
    const written = h.sessionsWritten[0]! as { tokenHash: string };
    const token = (res.headers.get('set-cookie')?.split(/[=;]/) ?? [])[1] ?? '';
    expect(written.tokenHash).toBe(hashSessionToken(token));
    expect(verifyPassword(hashPassword('pin-7777'), 'pin-7777')).toBe(true);
    expect(checkLoginThrottle('ss-officer|unknown', NOW).failures).toBe(0);
  });

  it('rejects a demo account while the DEMO_MODE off-switch is not set, with the same generic text (A31)', async () => {
    h.queue.push(fieldOfficerRow({ isDemo: true, passwordHash: hashPassword(DEMO_PIN) }));
    const res = await login('demo-officer-1', DEMO_PIN);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
  });

  it('lets a demo account log in only when DEMO_MODE=true (A31)', async () => {
    process.env.DEMO_MODE = 'true';
    h.queue.push(managerRow({ isDemo: true, passwordHash: hashPassword(DEMO_PIN) }));
    const res = await login('demo-manager', DEMO_PIN);
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { role: string } };
    expect(body.user?.role).toBe('branch_manager');
  });

  it('blocks the username+IP key after 5 failed attempts and returns Retry-After (A30)', async () => {
    for (let i = 0; i < 5; i++) {
      h.queue.push(fieldOfficerRow());
      const res = await login('ss-officer', 'pin-0000');
      expect(res.status).toBe(401);
    }
    const res = await login('ss-officer', 'pin-7777');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rates the same username scoped by client IP: another IP is a separate key', async () => {
    for (let i = 0; i < 5; i++) {
      h.queue.push(fieldOfficerRow());
      await login('ss-officer', 'pin-0000');
    }
    expect(checkLoginThrottle('ss-officer|unknown', NOW).blocked).toBe(true);
    h.queue.push(fieldOfficerRow());
    const res = await login('ss-officer', 'pin-7777', { 'x-forwarded-for': '9.9.9.9' });
    expect(res.status).toBe(200);
    expect(checkLoginThrottle('ss-officer|9.9.9.9', NOW).failures).toBe(0);
  });
});

describe('GET /api/me', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });
  afterEach(() => {
    resetLoginThrottleForTests();
  });

  it('resolves a live cookie session to the actor it belongs to', async () => {
    h.queue.push(sessionRow());
    const res = await app.request('/api/me', { headers: { cookie: cookieFor('goodtoken') } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { username: 'ss-officer', role: 'field_officer', branchId: BRANCH, officerId: OFFICER_ID }
    });
  });

  it('rejects an expired session (A30) before it can reach any data', async () => {
    h.queue.push(sessionRow({ expiresAt: new Date(NOW - 1000) }));
    const res = await app.request('/api/me', { headers: { cookie: cookieFor('stale') } });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('unauthorized');
  });

  it('rejects a request with no session hint (and no db query ran)', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    expect(h.queue).toHaveLength(0);
  });
});

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.sessionsWritten.length = 0;
  });
  afterEach(() => {
    resetLoginThrottleForTests();
  });

  it('deletes the session row and clears the cookie, whatever the cookie said', async () => {
    h.queue.push(sessionRow());
    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: cookieFor('anything') } });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    const setCookie = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(setCookie).toContain('fc_session=');
    expect(setCookie).toContain('max-age=0');
  });

  it('is idempotent with no session cookie at all', async () => {
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/import through a cookie session', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });
  afterEach(() => {
    resetLoginThrottleForTests();
  });

  it('a field officer session reaches the manager-only gate and gets 403', async () => {
    h.queue.push(sessionRow());
    const res = await app.request('/api/import', { method: 'POST', headers: { cookie: cookieFor('token-as-officer') } });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden');
  });

  it('a field officer via the unchanged basic-auth path also gets 403', async () => {
    h.queue.push(fieldOfficerRow());
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('ss-officer:pin-7777', 'utf8').toString('base64')}` }
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden');
  });
});
