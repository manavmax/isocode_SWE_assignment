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
  /** Every insert the routes attempt: the value plus its onConflictDoUpdate
   * payload when present. Session writes carry tokenHash, attempt writes
   * carry windowStart — the fake cannot see table names, tests sort by shape. */
  const writes: { value: Record<string, unknown>; conflictSet: unknown }[] = [];
  const counters = { deletes: 0 };
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
  const resolved = Promise.resolve(undefined);
  const fakeDb = {
    select: () => chain,
    insert: () => ({
      values: (value: unknown) => {
        const entry = { value: value as Record<string, unknown>, conflictSet: null as unknown };
        writes.push(entry);
        return {
          onConflictDoUpdate: (arg: unknown) => {
            entry.conflictSet = arg;
            return resolved;
          },
          then: resolved.then.bind(resolved),
          catch: resolved.catch.bind(resolved),
          finally: resolved.finally.bind(resolved)
        };
      }
    }),
    delete: () => ({
      where: async () => {
        counters.deletes += 1;
        return { rowCount: 1 };
      }
    })
  };
  return { queue, writes, counters, fakeDb };
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
import { LOGIN_WINDOW_MS } from './rateLimit.js';
import { hashSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';
import { DEMO_PIN } from './demo.js';

/** Row the login route's throttle lookup would read from login_attempt. */
function attemptRow(failCount: number, windowStartMs: number) {
  return { failCount, windowStart: new Date(windowStartMs) };
}

function attemptWrites() {
  return h.writes.filter((w) => 'windowStart' in w.value && w.conflictSet !== null);
}

function sessionWrites() {
  return h.writes.filter((w) => 'tokenHash' in w.value);
}

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
    h.writes.length = 0;
    h.counters.deletes = 0;
  });
  afterEach(() => {
    delete process.env.DEMO_MODE;
  });

  it('requires a username and pin', async () => {
    const res = await login('', '');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('username and pin are required');
    expect(h.queue).toHaveLength(0); // nothing ran before validation
  });

  it('answers an unknown username with the generic wrong-username-or-PIN message', async () => {
    h.queue.push([]); // throttle lookup: no locked key
    h.queue.push([]); // user lookup: no rows
    const res = await login('nobody', 'pin-7777');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
    expect(attemptWrites()).toHaveLength(1); // counted as a failure (A30)
  });

  it('answers a wrong PIN with the generic message and records the failure (real scrypt verify ran)', async () => {
    h.queue.push([]);
    h.queue.push(fieldOfficerRow());
    const res = await login('ss-officer', 'pin-0000');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
    const writes = attemptWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.value).toMatchObject({ key: 'ss-officer|unknown', failCount: 1 });
  });

  it('a correct PIN checks the scrypt hash, records a hashed session, and sets an HttpOnly Secure SameSite=Lax 7-day cookie', async () => {
    h.queue.push([]);
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
    const written = sessionWrites();
    expect(written).toHaveLength(1);
    const token = (res.headers.get('set-cookie')?.split(/[=;]/) ?? [])[1] ?? '';
    expect(written[0]!.value.tokenHash).toBe(hashSessionToken(token));
    expect(verifyPassword(hashPassword('pin-7777'), 'pin-7777')).toBe(true);
    expect(attemptWrites()).toHaveLength(0); // open key: nothing recorded
    expect(h.counters.deletes).toBe(1); // a successful login clears the counter (A30)
  });

  it('rejects a demo account while the DEMO_MODE off-switch is not set, with the same generic text (A31)', async () => {
    h.queue.push([]);
    h.queue.push(fieldOfficerRow({ isDemo: true, passwordHash: hashPassword(DEMO_PIN) }));
    const res = await login('demo-officer-1', DEMO_PIN);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
  });

  it('lets a demo account log in only when DEMO_MODE=true (A31)', async () => {
    process.env.DEMO_MODE = 'true';
    h.queue.push([]);
    h.queue.push(managerRow({ isDemo: true, passwordHash: hashPassword(DEMO_PIN) }));
    const res = await login('demo-manager', DEMO_PIN);
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { role: string } };
    expect(body.user?.role).toBe('branch_manager');
    expect(attemptWrites()).toHaveLength(0);
  });

  it('a key with 5 recorded failures inside the window answers 429 + Retry-After without ever probing the user (A30)', async () => {
    h.queue.push(attemptRow(5, NOW + 60_000)); // the locked login_attempt row
    const res = await login('ss-officer', 'pin-7777');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.queue).toHaveLength(0); // the user lookup never ran
    expect(sessionWrites()).toHaveLength(0);
  });

  it('a failure row older than the 15-minute window does not block and starts a fresh window', async () => {
    h.queue.push(attemptRow(5, NOW - LOGIN_WINDOW_MS - 60_000)); // expired window
    h.queue.push(fieldOfficerRow());
    const res = await login('ss-officer', 'pin-0000');
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe('wrong username or PIN');
    expect(attemptWrites()).toHaveLength(1); // next failure opened a fresh window
  });
});

describe('GET /api/me', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
    h.counters.deletes = 0;
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
    h.writes.length = 0;
    h.counters.deletes = 0;
  });

  it('deletes the session row and clears the cookie, whatever the cookie said', async () => {
    h.queue.push(sessionRow());
    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: cookieFor('anything') } });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    const setCookie = (res.headers.get('set-cookie') ?? '').toLowerCase();
    expect(setCookie).toContain('fc_session=');
    expect(setCookie).toContain('max-age=0');
    expect(h.counters.deletes).toBe(1);
    expect(h.writes).toHaveLength(0);
  });

  it('is idempotent with no session cookie at all', async () => {
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(h.counters.deletes).toBe(0);
  });
});

describe('POST /api/import through a cookie session', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
    h.counters.deletes = 0;
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
