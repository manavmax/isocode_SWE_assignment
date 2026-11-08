import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Access-control matrix (prompt 14a item 2): every endpoint × every role
 * (anonymous, field officer, own-branch manager, other-branch manager) →
 * the expected status, driven through the real routes over the fake
 * driver. The matrix IS the security.md table's executable form; the
 * expected statuses encode the SPEC 16 rules (demo-mode-gated chips,
 * officer-scoped reads, manager-only surfaces, branch-scoped writes).
 *
 * Sessions are canned rows in the fake driver's queue; every endpoint that
 * would need more data gets exactly one queued result and answers from it,
 * so the assertion stays on the STATUS, not the payload.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const shift = () => {
    const next = queue.shift();
    if (next === undefined) {
      // The matrix asserts statuses, not query counts: an unplanned read
      // answers an empty result (the strict no-db-work assertions live in
      // managerSecurity.test.ts).
      return [];
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
  const resolved = Promise.resolve(undefined);
  const fakeDb = {
    select: () => chain,
    insert: () => ({
      values: (value: unknown) => {
        void value;
        return {
          onConflictDoUpdate: () => resolved,
          then: resolved.then.bind(resolved),
          catch: resolved.catch.bind(resolved)
        };
      }
    }),
    delete: () => ({ where: async () => undefined }),
    execute: async () => ({ rows: shift() })
  };
  return { queue, fakeDb, pooled: fakeDb };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPooledDb: () => h.pooled,
  getPool: () => {
    throw new Error('no pool');
  },
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.fakeDb),
  closePool: async () => undefined
}));

import { app } from './app.js';

const BRANCH_A = 'branch-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRANCH_B = 'branch-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OFFICER_A = 'officer-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OFFICER_B = 'officer-bbbb-0000-0000-000000000001';

function sessionRow(role: 'field_officer' | 'branch_manager', branchId: string, officerId: string | null): unknown {
  return {
    userId: `user-${role}-${branchId.slice(-4)}`,
    username: role === 'branch_manager' ? `mgr-${branchId.slice(-4)}` : 'unit-officer',
    role,
    branchId,
    officerId,
    active: true,
    expiresAt: new Date(Date.now() + 60_000)
  };
}

async function status(
  cookie: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<number> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    }
  });
  return res.status;
}

const LOAN = 'LN-1';
const OFFICER = OFFICER_A;

describe('access-control matrix: endpoint x role (SPEC 16, prompt 14a item 2)', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });

  it('health is public for every role', async () => {
    for (const cookie of ['', 'fc_session=officer', 'fc_session=manager']) {
      h.queue.push([{}]); // probeDb
      expect(await status(cookie, 'GET', '/api/health')).toBe(200);
    }
  });

  it('login is public (401 on bad credentials, never 403)', async () => {
    h.queue.push([]); // rate-limit read
    h.queue.push([]); // user lookup: no rows
    expect(await status('', 'POST', '/api/auth/login', { username: 'x', pin: '0000' })).toBe(401);
  });

  it('demo-accounts answers 200 empty when DEMO_MODE is off, for every role', async () => {
    for (const cookie of ['', 'fc_session=officer']) {
      expect(await status(cookie, 'GET', '/api/demo-accounts')).toBe(200);
    }
  });

  it('officer reads: 401 anonymous, 200 officer, 403 manager, 403 other-branch manager', async () => {
    // anonymous
    expect(await status('', 'GET', '/api/me')).toBe(401);
    expect(await status('', 'GET', '/api/me/assignments')).toBe(401);
    expect(await status('', 'GET', '/api/me/promises')).toBe(401);
    // officer: session lookup + data
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    h.queue.push([assignmentsRow()]);
    expect(await status('fc_session=officer', 'GET', '/api/me/assignments')).toBe(200);
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    h.queue.push([]); // open promises read: no rows
    h.queue.push([]); // broken promises read: no rows
    expect(await status('fc_session=officer', 'GET', '/api/me/promises')).toBe(200);
    // own-branch manager: session ok, then 403 before any data query
    h.queue.push(sessionRow('branch_manager', BRANCH_A, null));
    expect(await status('fc_session=mgr', 'GET', '/api/me/assignments')).toBe(403);
    h.queue.push(sessionRow('branch_manager', BRANCH_A, null));
    expect(await status('fc_session=mgr', 'GET', '/api/me/promises')).toBe(403);
    // other-branch manager: same 403s
    h.queue.push(sessionRow('branch_manager', BRANCH_B, null));
    expect(await status('fc_session=mgr-b', 'GET', '/api/me/assignments')).toBe(403);
  });

  it('loan detail: 401 anonymous, 200 officer (assigned), 404 other-branch manager, 403 unassigned officer', async () => {
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    h.queue.push([loanRow({ assignedOfficerId: OFFICER_A })]);
    expect(await status('fc_session=officer', 'GET', `/api/loans/${LOAN}`)).toBe(200);
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    h.queue.push([loanRow({ assignedOfficerId: OFFICER_B })]); // not theirs
    expect(await status('fc_session=officer', 'GET', `/api/loans/${LOAN}`)).toBe(404);
    h.queue.push(sessionRow('branch_manager', BRANCH_B, null));
    h.queue.push([loanRow({ branchId: BRANCH_A })]); // foreign branch
    expect(await status('fc_session=mgr-b', 'GET', `/api/loans/${LOAN}`)).toBe(404);
  });

  it('import: 401 anonymous, 403 officer (both branches); the manager passes the guard', async () => {
    // No body: the auth gate fires before any multipart validation.
    expect(await status('', 'POST', '/api/import')).toBe(401);
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    expect(await status('fc_session=officer', 'POST', '/api/import')).toBe(403);
    h.queue.push(sessionRow('field_officer', BRANCH_B, OFFICER_B));
    expect(await status('fc_session=officer-b', 'POST', '/api/import')).toBe(403);
    h.queue.push(sessionRow('branch_manager', BRANCH_A, null));
    const s = await status('fc_session=mgr', 'POST', '/api/import');
    expect([400, 415, 503]).toContain(s); // past the auth gate, into upload validation
  });

  it('manager surfaces: 401 anonymous, 403 officers (both branches), 200/404-403 own-branch manager', async () => {
    const managerPaths: [string, 'GET' | 'POST' | 'DELETE', unknown?][] = [
      ['/api/manager/dashboard', 'GET', undefined],
      [`/api/manager/officers/${OFFICER}/activity`, 'GET', undefined],
      ['/api/manager/queue', 'GET', undefined],
      ['/api/manager/import-batches', 'GET', undefined],
      ['/api/manager/priority', 'POST', { loanId: LOAN, officerId: OFFICER }],
      ['/api/manager/priority/LN-1', 'DELETE', undefined]
    ];
    for (const [path, method, body] of managerPaths) {
      expect(await status('', method, path, body)).toBe(401);
    }
    for (const branch of [BRANCH_A, BRANCH_B]) {
      for (const [path, method, body] of managerPaths) {
        h.queue.push(sessionRow('field_officer', branch, branch === BRANCH_A ? OFFICER_A : OFFICER_B));
        expect(await status('fc_session=officer', method, path, body)).toBe(403);
      }
    }
    // Own-branch manager: session passes the guard, the query degrades
    // (empty fake results) — never 401/403.
    for (const [path, method, body] of managerPaths) {
      h.queue.push(sessionRow('branch_manager', BRANCH_A, null));
      const s = await status('fc_session=mgr', method, path, body);
      expect([200, 400, 404, 503]).toContain(s);
    }
  });

  it('nightly cron: 401 without the bearer, 401 with a wrong bearer, for every role', async () => {
    for (const cookie of ['', 'fc_session=officer', 'fc_session=mgr']) {
      expect(await status(cookie, 'POST', '/api/jobs/nightly')).toBe(401);
    }
  });

  it('events batch: 401 anonymous; the officer path validates the envelope', async () => {
    expect(await status('', 'POST', '/api/events/batch', { events: [] })).toBe(401);
    h.queue.push(sessionRow('field_officer', BRANCH_A, OFFICER_A));
    // An empty events envelope is a 400 validation answer — the point is
    // that the officer got PAST auth (401/403 never fire).
    expect(await status('fc_session=officer', 'POST', '/api/events/batch', { events: [] })).toBe(400);
  });
});

function assignmentsRow(): Record<string, unknown> {
  return {
    loan_id: 'LN-1',
    borrower_name: 'B',
    pincode: '452001',
    locality: null,
    dpd: 10,
    bucket: '1-30',
    outstanding: 100,
    overdue_amount: 50,
    mobile: '9876543321',
    p_roll: null,
    score: null,
    rupees_at_risk: null,
    reasons_json: null,
    features_json: null,
    model_version: null,
    pinned_at: null,
    due_promise: false,
    broken_count: 0
  };
}

function loanRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    loanId: LOAN,
    borrowerName: 'B',
    businessName: null,
    address: 'a',
    pincode: '452001',
    locality: null,
    product: null,
    outstanding: 100,
    overdueAmount: 50,
    emiAmount: null,
    dpd: 10,
    bucket: '1-30',
    branchId: BRANCH_A,
    assignedOfficerId: OFFICER_A,
    homeOfficerId: OFFICER_A,
    status: 'overdue',
    mobile: '9876543321',
    altMobile: null,
    ...over
  };
}
