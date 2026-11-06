import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/loans/:id/reveal-phone with NO live database (fake driver, as in
 * authFlow.test.ts). The contact-window gate runs on SERVER time, so the
 * suite freezes the system clock with vi.useFakeTimers around IST instants
 * instead of hoping the wall clock cooperates. The limiter lives in the
 * login_attempt table (A56), so its writes appear as `reveal|` keyed inserts.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const writes: { kind: string; value: Record<string, unknown> }[] = [];
  const shift = () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('fake db queue empty (a query resolved with no queued result)');
    }
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
      values: (value: unknown) => {
        const record = value as Record<string, unknown>;
        if (String(record.key ?? '').startsWith('reveal|')) {
          writes.push({ kind: 'reveal-counter', value: record });
        } else {
          writes.push({ kind: 'audit', value: record });
        }
        const done = Promise.resolve();
        return {
          onConflictDoUpdate: () => done,
          returning: async () => [{ id: crypto.randomUUID() }],
          then: (resolve: (rows: unknown) => void, reject: (e: unknown) => void) => done.then(resolve, reject),
          catch: (reject: (e: unknown) => void) => done.catch(reject)
        };
      }
    }),
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 0 }) }) }),
    delete: () => ({ where: async () => ({ rowCount: 0 }) })
  };
  return { queue, writes, fakeDb };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPool: () => {
    throw new Error('getPool is not used by reveal tests');
  },
  getPooledDb: () => h.fakeDb,
  withTx: async () => {
    throw new Error('withTx is not used by reveal tests');
  },
  closePool: async () => undefined
}));

import { app } from './app.js';
import { SESSION_COOKIE } from './sessions.js';

const OFFICER_ID = 'officer-reveal-00000000000000000000000001';
const BRANCH_ID = 'branch-reveal-0000000000000000000000ZZZ';
const LOAN_ID = 'LN-23001';

/** 10:00 IST on a Friday — comfortably inside the window. */
const INSIDE_IST = Date.parse('2026-11-06T04:30:00.000Z');
/** 01:00 IST on the NEXT calendar day (19:30Z) — outside the window. */
const OUTSIDE_IST = Date.parse('2026-11-06T19:30:00.000Z');
/** Window-start boundary itself: 08:00:00 IST — inside (inclusive). */
const WINDOW_START_IST = Date.parse('2026-11-06T02:30:00.000Z');
/** 19:00:00 IST — outside (exclusive end). */
const WINDOW_END_IST = Date.parse('2026-11-06T13:30:01.000Z');

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    userId: 'user-reveal-0000000000000000000000000001',
    username: 'reveal-officer',
    role: 'field_officer',
    branchId: BRANCH_ID,
    officerId: OFFICER_ID,
    active: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...over
  };
}

function loanRow(over: Record<string, unknown> = {}) {
  return {
    loanId: LOAN_ID,
    assignedOfficerId: OFFICER_ID,
    mobile: '9876543210',
    altMobile: '9123456780',
    ...over
  };
}

function counterRow(failCount: number, windowStartMs = Date.now()) {
  return { failCount, windowStart: new Date(windowStartMs) };
}

function cookie() {
  return `${SESSION_COOKIE}=reveal-officer-token`;
}

const get = (loanId = LOAN_ID, sessionOverride: Record<string, unknown> | null = null) => {
  // The session lookup is the first pop of every request.
  h.queue.unshift(sessionRow(sessionOverride ?? {}));
  return app.request(`/api/loans/${loanId}/reveal-phone`, { headers: { cookie: cookie() } });
};

const auditWrites = () => h.writes.filter((w) => w.kind === 'audit' && w.value.action === 'phone_reveal');
const counterWrites = () => h.writes.filter((w) => w.kind === 'reveal-counter');

describe('GET /api/loans/:id/reveal-phone — gates', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
    vi.useFakeTimers({ now: new Date(INSIDE_IST), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 401 without a session cookie, before any query', async () => {
    const res = await app.request(`/api/loans/${LOAN_ID}/reveal-phone`);
    expect(res.status).toBe(401);
    expect(h.queue).toHaveLength(0);
  });

  it('refuses managers — reveal is an officer-only capability', async () => {
    const res = await get(LOAN_ID, { role: 'branch_manager', officerId: null });
    expect(res.status).toBe(403);
    expect(h.queue).toHaveLength(0); // loan lookup never ran
  });

  it('loan not assigned to this officer (or unknown loan) answers the same generic 404, any time of day', async () => {
    h.queue.push(loanRow({ assignedOfficerId: 'officer-reveal-ZZZZZZZZZZZZZZZZZZZZZZZZZZ' }));
    const res = await get('LN-23002');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not found');
    expect(auditWrites()).toHaveLength(0); // reveal attempt is not audited
    expect(counterWrites()).toHaveLength(0);
  });
});

describe('GET /api/loans/:id/reveal-phone — the window is SERVER time (SPEC 16)', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals INSIDE the window and returns the UNMASKED number', async () => {
    vi.useFakeTimers({ now: new Date(INSIDE_IST), toFake: ['Date'] });
    h.queue.push(loanRow());
    h.queue.push(counterRow(0));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mobile: string; altMobile: string | null };
    expect(body.mobile).toBe('9876543210'); // raw, by design — this is the reveal
    expect(body.mobile).not.toContain('X');
    expect(body.altMobile).toBe('9123456780');
    expect(counterWrites()).toHaveLength(1); // counted
    expect(auditWrites()).toHaveLength(1); // audited
  });

  it('08:00:00 IST exactly is inside (inclusive start)', async () => {
    vi.useFakeTimers({ now: new Date(WINDOW_START_IST), toFake: ['Date'] });
    h.queue.push(loanRow());
    h.queue.push(counterRow(0));
    const res = await get();
    expect(res.status).toBe(200);
  });

  it('19:00:00 IST plus a hair is outside: a clear error, no audit, no count', async () => {
    vi.useFakeTimers({ now: new Date(WINDOW_END_IST), toFake: ['Date'] });
    h.queue.push(loanRow());
    const res = await get();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('08:00-19:00 IST');
    expect(h.queue).toHaveLength(0); // limiter was never reached
    expect(h.writes).toHaveLength(0);
  });

  it('deep outside the window (01:00 IST), same refusal', async () => {
    vi.useFakeTimers({ now: new Date(OUTSIDE_IST), toFake: ['Date'] });
    h.queue.push(loanRow());
    const res = await get();
    expect(res.status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('the verdict survives a device lying about its timezone (no device input reaches the check)', async () => {
    vi.useFakeTimers({ now: new Date(INSIDE_IST), toFake: ['Date'] });
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: a device that swears it is evening
    try {
      h.queue.push(loanRow());
      h.queue.push(counterRow(0));
      const res = await get();
      expect(res.status).toBe(200); // server says 10:00 IST, so the reveal stands
    } finally {
      delete process.env.TZ;
    }
  });
});

describe('GET /api/loans/:id/reveal-phone — 30 per hour per officer, DB-backed (A56)', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
    vi.useFakeTimers({ now: new Date(INSIDE_IST), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('at the cap: 429 without revealing, and nothing counted or audited', async () => {
    h.queue.push(loanRow());
    h.queue.push(counterRow(30, INSIDE_IST - 1000)); // 30 in the current hour
    const res = await get();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain('30 per officer per hour');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0); // same contract as the login throttle
    expect(h.writes).toHaveLength(0);
  });

  it('at 29: allowed, one counter increment, one audit row', async () => {
    h.queue.push(loanRow());
    h.queue.push(counterRow(29, INSIDE_IST - 1000));
    const res = await get();
    expect(res.status).toBe(200);
    expect(counterWrites()).toHaveLength(1);
    expect(auditWrites()).toHaveLength(1);
    const counter = counterWrites()[0]!.value;
    expect(counter.key).toBe(`reveal|${OFFICER_ID}`); // shared table, prefixed namespace
  });

  it('an expired window (an hour+ old row) reopens the limiter without a reset', async () => {
    h.queue.push(loanRow());
    h.queue.push(counterRow(30, INSIDE_IST - 60 * 60_000)); // previous hour's exhausted key
    const res = await get();
    expect(res.status).toBe(200);
    expect(counterWrites()).toHaveLength(1);
  });

  it('the audit row names the actor, action and loan but no phone data', async () => {
    h.queue.push(loanRow());
    h.queue.push(counterRow(0));
    await get();
    const audit = auditWrites()[0]!.value;
    expect(audit).toMatchObject({ actor: 'reveal-officer', action: 'phone_reveal', subject: LOAN_ID });
    expect(JSON.stringify(audit.valueOf())).not.toContain('9876543210'); // PII scrub (SPEC 16)
    expect(JSON.stringify(audit.valueOf())).not.toContain('9123456780');
  });
});
