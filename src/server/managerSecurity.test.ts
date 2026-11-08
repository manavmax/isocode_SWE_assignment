import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Manager-route security (SPEC 13, prompt 13 item 7), offline over the
 * fake driver: officers answer 403 on EVERY manager endpoint before any
 * query runs, an unauthenticated caller answers 401, and the 403 verdicts
 * consume no database work (the route guard is checked before the session's
 * data is touched). Branch scoping itself lives in the SQL (every manager
 * read filters actor.branchId; pin/unpin re-check the loan's and officer's
 * branch in the dal) and is proven live by smoke:live.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const shift = () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('fake db queue empty');
    }
    return Array.isArray(next) ? next : [next];
  };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    orderBy: () => chain,
    limit: async () => shift(),
    then: (resolve: (rows: unknown) => void) => Promise.resolve(shift()).then(resolve)
  };
  const fakeDb = {
    select: () => chain,
    insert: () => ({ values: async () => null }),
    delete: () => ({ where: async () => undefined }),
    execute: async () => ({ rows: shift() })
  };
  return { queue, fakeDb };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPool: () => {
    throw new Error('no pool in unit tests');
  },
  withTx: async () => {
    throw new Error('no tx in unit tests');
  },
  closePool: async () => undefined
}));

import { app } from './app.js';

const session = (role: 'field_officer' | 'branch_manager', branchId = 'branch-mgr-0000000000000000000000000001'): unknown => [
  { userId: 'user-1', username: role === 'branch_manager' ? 'unit-mgr' : 'unit-officer', role, branchId, officerId: role === 'branch_manager' ? null : 'officer-1', active: true, expiresAt: new Date(Date.now() + 60_000) }
];

const OFFICER_ID = 'officer-0000-0000-0000-000000000001';

async function call(path: string, init: RequestInit = {}, cookie = 'fc_session=t'): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  return { status: res.status, body: await res.json() };
}

describe('manager endpoints are manager-only (SPEC 13, prompt 13 item 7)', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });

  it('401 without a session on every manager endpoint', async () => {
    for (const [path, init] of [
      ['/api/manager/dashboard', {}],
      ['/api/manager/officers/x/activity', {}],
      ['/api/manager/priority', { method: 'POST', body: JSON.stringify({ loanId: 'L', officerId: OFFICER_ID }) }],
      ['/api/manager/priority/L-1', { method: 'DELETE' }]
    ] as const) {
      const { status } = await call(path, init, '');
      expect(status, path).toBe(401);
    }
    expect(h.queue).toHaveLength(0); // nothing ran
  });

  it('403 for a field officer on every manager endpoint — before any db work', async () => {
    h.queue.push(session('field_officer')); // session lookup per call
    h.queue.push(session('field_officer'));
    h.queue.push(session('field_officer'));
    h.queue.push(session('field_officer'));
    const dashboard = await call('/api/manager/dashboard');
    expect(dashboard.status).toBe(403);
    const activity = await call(`/api/manager/officers/${OFFICER_ID}/activity`);
    expect(activity.status).toBe(403);
    const pin = await call('/api/manager/priority', { method: 'POST', body: JSON.stringify({ loanId: 'LN-1', officerId: OFFICER_ID }) });
    expect(pin.status).toBe(403);
    const unpin = await call('/api/manager/priority/LN-1', { method: 'DELETE' });
    expect(unpin.status).toBe(403);
    // Only the four session lookups ran; no dashboard/pin query touched the db.
    expect(h.queue).toHaveLength(0);
  });

  it('a manager proceeds past the guard (degraded without a real db, never 403)', async () => {
    h.queue.push(session('branch_manager'));
    const { status } = await call('/api/manager/dashboard');
    expect(status).toBe(503); // the fake driver returns no rows -> degraded, not forbidden
  });
});
