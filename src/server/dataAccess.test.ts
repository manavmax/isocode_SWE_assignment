import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Loan/assignment data access with NO live database: same fake-driver shape
 * as authFlow.test.ts (every query resolution pops one queued result; a bare
 * row is a one-row result, `[]` means no rows). The permission rules
 * themselves run as the real production code, both through canReadLoan
 * directly (pure) and through the HTTP routes.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
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
    insert: () => ({ values: async (value: unknown) => value }),
    delete: () => ({ where: async () => ({ rowCount: 0 }) }),
    execute: async () => ({ rows: shift() })
  };
  return { queue, fakeDb };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPool: () => {
    throw new Error('getPool is not used by data-access tests');
  },
  getPooledDb: () => h.fakeDb,
  withTx: async () => {
    throw new Error('withTx is not used by data-access tests');
  },
  closePool: async () => undefined
}));

import { app } from './app.js';
import { canReadLoan, type Actor } from './dal.js';

const BRANCH_A = 'branch-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRANCH_B = 'branch-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OFFICER_A = 'officer-a-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OFFICER_B = 'officer-b-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-actor-0000000000000000000000000001',
    username: 'unit-actor',
    role: 'field_officer',
    branchId: BRANCH_A,
    officerId: OFFICER_A,
    active: true,
    ...over
  };
}

function loanRow(over: Record<string, unknown> = {}) {
  return {
    loanId: 'LN-2001',
    borrowerName: 'Asha Devi',
    businessName: null,
    address: 'shop 4, market road',
    pincode: '456001',
    locality: 'Vijay',
    product: null,
    outstanding: 110000,
    overdueAmount: 20000,
    emiAmount: null,
    dpd: 15,
    bucket: '0_30',
    assignedOfficerId: OFFICER_A,
    homeOfficerId: OFFICER_A,
    status: 'overdue',
    mobile: '9876543321',
    altMobile: '9700011234',
    branchId: BRANCH_A,
    ...over
  };
}

/** The worklist query's snake_case row (score_log joined, flags included). */
function assignmentsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loan_id: 'LN-1001',
    borrower_name: 'Scorecard Borrower',
    business_name: null,
    low_lane: false,
    pincode: '452001',
    locality: null,
    dpd: 18,
    bucket: '1-30',
    outstanding: 800_000,
    overdue_amount: 120_000,
    mobile: '9876543321',
    p_roll: null,
    score: null,
    rupees_at_risk: null,
    reasons_json: null,
    features_json: null,
    model_version: null,
    pinned_at: null,
    due_promise: false,
    broken_count: 0,
    ...overrides
  };
}

function sessionRowFor(who: Partial<Actor> = {}) {
  const a = actor(who);
  return {
    userId: a.userId,
    username: a.username,
    role: a.role,
    branchId: a.branchId,
    officerId: a.officerId,
    active: true,
    expiresAt: new Date(Date.now() + 60_000)
  };
}

async function getMenu(cookie: string = 'fc_session=token-unit'): Promise<{ status: number; body: unknown }> {
  const res = await app.request('/api/me/assignments', { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
}

async function getLoan(loanId: string, cookie: string = 'fc_session=token-unit'): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/api/loans/${loanId}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
}

describe('canReadLoan (pure visibility rule, A33)', () => {
  it('officer A cannot read officer B loan even inside the same branch', () => {
    expect(canReadLoan(actor(), loanRow({ assignedOfficerId: OFFICER_B }))).toBe(false);
  });
  it('an officer whose branch differs from the loan branch still cannot read an unassigned loan', () => {
    expect(canReadLoan(actor(), loanRow({ branchId: BRANCH_B, assignedOfficerId: null }))).toBe(false);
  });
  it('a manager cannot read another branch loan, but reads their own branch', () => {
    expect(canReadLoan(actor({ role: 'branch_manager', officerId: null, branchId: BRANCH_B }), loanRow({ branchId: BRANCH_A }))).toBe(false);
    expect(canReadLoan(actor({ role: 'branch_manager', officerId: null, branchId: BRANCH_B }), loanRow({ branchId: BRANCH_B }))).toBe(true);
  });
  it('the assigned officer reads their loan; an inactive actor reads nothing', () => {
    expect(canReadLoan(actor(), loanRow())).toBe(true);
    expect(canReadLoan(actor({ active: false }), loanRow())).toBe(false);
    expect(canReadLoan(null, loanRow())).toBe(false);
  });
});

describe('GET /api/me/assignments', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });

  it('returns the officer overdue worklist with masked phones and no raw numbers', async () => {
    h.queue.push(sessionRowFor());
    // The worklist query is one raw SQL execute over snake_case rows (prompt
    // 12: score_log join + worklist order). With no scores the order falls
    // to the fallback comparator: broken, then DPD, then overdue.
    h.queue.push([
      assignmentsRow({ loan_id: 'LN-2002', dpd: 40 }),
      assignmentsRow({ loan_id: 'LN-2001', dpd: 15 })
    ]);
    const { status, body } = await getMenu();
    expect(status).toBe(200);
    const { assignments, scoringMode } = body as { assignments: Record<string, unknown>[]; scoringMode: string };
    expect(assignments).toHaveLength(2);
    expect(assignments[0]!.loanId).toBe('LN-2002');
    expect(assignments[0]!.mobileMasked).toBe('98XXXXXX21');
    expect(assignments[0]!.dpd).toBe(40);
    expect(assignments[0]!.score).toBeNull();
    expect(scoringMode).toBe('fallback'); // no score rows -> never fake a model
    expect(JSON.stringify(body)).not.toContain('9876543321');
  });

  it('carries the score fields through and reports scorecard mode when every loan is scored', async () => {
    h.queue.push(sessionRowFor());
    // The fake driver has no SQL engine: the pushed order IS the server's
    // worklist order (the SQL ORDER BY and its pure counterpart,
    // worklistOrder, are tested separately).
    h.queue.push([
      assignmentsRow({
        loan_id: 'LN-B',
        dpd: 30,
        score: 25,
        p_roll: 0.25,
        rupees_at_risk: 900_000,
        due_promise: true,
        reasons_json: [{ feature: 'dpd', contribution: 0.3, evidence: { days: 30 } }],
        features_json: { band: 'medium', limitedData: ['overdueEmiMultiples'] }
      }),
      assignmentsRow({ loan_id: 'LN-A', dpd: 10, score: 55, p_roll: 0.55, rupees_at_risk: 550_000 })
    ]);
    const { body } = await getMenu();
    const { assignments, scoringMode } = body as { assignments: Record<string, unknown>[]; scoringMode: string };
    expect(scoringMode).toBe('scorecard');
    expect(assignments.map((a) => a.loanId)).toEqual(['LN-B', 'LN-A']);
    expect(assignments[0]!.score).toBe(25);
    expect(assignments[0]!.band).toBe('medium');
    expect(assignments[0]!.rupeesAtRisk).toBe(900_000);
    expect(assignments[0]!.limitedData).toBe(true);
    expect(assignments[0]!.topReasons).toEqual([{ feature: 'dpd', contribution: 0.3, evidence: { days: 30 } }]);
  });

  it('403 for a manager: the worklist is officer-scoped (no loan query even ran)', async () => {
    h.queue.push(sessionRowFor({ role: 'branch_manager', officerId: null, username: 'ss-mgr' }));
    const { status, body } = await getMenu();
    expect(status).toBe(403);
    expect((body as { error: string }).error).toBe('forbidden');
    expect(h.queue).toHaveLength(0);
  });

  it('401 without a cookie session', async () => {
    const { status } = await getMenu('');
    expect(status).toBe(401);
    expect(h.queue).toHaveLength(0);
  });
});

describe('GET /api/loans/:id', () => {
  beforeEach(() => {
    h.queue.length = 0;
  });

  it('the assigned officer reads their loan; the payload carries masked phones and no row phones', async () => {
    h.queue.push(sessionRowFor());
    h.queue.push(loanRow());
    const { status, body } = await getLoan('LN-2001');
    expect(status).toBe(200);
    const { loan } = body as { loan: Record<string, unknown> };
    expect(loan.loanId).toBe('LN-2001');
    expect(loan.mobileMasked).toBe('98XXXXXX21');
    expect(loan.altMobileMasked).toBe('97XXXXXX34');
    expect(loan).not.toHaveProperty('mobile');
    expect(loan).not.toHaveProperty('altMobile');
    expect(JSON.stringify(body)).not.toContain('9876543321');
    expect(JSON.stringify(body)).not.toContain('9700011234');
  });

  it('officer A gets 404 for officer B loan (same generic body as a missing loan)', async () => {
    h.queue.push(sessionRowFor());
    h.queue.push(loanRow({ assignedOfficerId: OFFICER_B }));
    const { status, body } = await getLoan('LN-2001');
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe('not found');
  });

  it('an officer gets 404 for an unassigned loan on another branch', async () => {
    h.queue.push(sessionRowFor());
    h.queue.push(loanRow({ branchId: BRANCH_B, assignedOfficerId: null }));
    const { status } = await getLoan('LN-2001');
    expect(status).toBe(404);
  });

  it('a manager gets 404 for another branch loan and 200 inside their own branch', async () => {
    h.queue.push(sessionRowFor({ role: 'branch_manager', officerId: null, username: 'ss-mgr', branchId: BRANCH_B }));
    h.queue.push(loanRow({ branchId: BRANCH_A }));
    const first = await getLoan('LN-2001');
    expect(first.status).toBe(404);

    h.queue.push(sessionRowFor({ role: 'branch_manager', officerId: null, username: 'ss-mgr', branchId: BRANCH_B }));
    h.queue.push(loanRow({ branchId: BRANCH_B }));
    const second = await getLoan('LN-2001');
    expect(second.status).toBe(200);
  });

  it('an existing actor reading a truly missing loan gets the same 404 body', async () => {
    h.queue.push(sessionRowFor());
    h.queue.push([]);
    const { status, body } = await getLoan('LN-9999');
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe('not found');
  });

  it('401 without a cookie session', async () => {
    const { status } = await getLoan('LN-2001', '');
    expect(status).toBe(401);
    expect(h.queue).toHaveLength(0);
  });
});
