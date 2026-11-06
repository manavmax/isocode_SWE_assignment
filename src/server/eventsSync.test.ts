import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/events/batch with NO live database — same fake-driver approach as
 * authFlow.test.ts: every query resolution pops one pre-queued result (a row
 * array, or `[]` for "no rows"). Sequencing follows the real call order per
 * item: loan select → (assignment history) → existing event select →
 * (promise chain) → transaction writes. Everything above the driver — zod
 * grading, timing derivation, idempotency, promise rules — runs as production
 * code, and withTx is observed so the promise/event writes are provably one
 * transaction-shaped callback.
 */
const h = vi.hoisted(() => {
  const queue: unknown[] = [];
  const writes: {
    kind: string;
    value: Record<string, unknown>;
    conflict: 'none' | 'nothing' | 'update';
    generatedId?: string;
  }[] = [];
  let txCallbackRuns = 0;
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
  const isEventWrite = (value: Record<string, unknown>) => 'attemptedAtIst' in value;
  const isPromiseWrite = (value: Record<string, unknown>) => 'promisedDate' in value && 'graceDays' in value;
  const isAuditWrite = (value: Record<string, unknown>) => 'action' in value;
  const fakeDb = {
    select: () => chain,
    insert: () => ({
      values: (value: unknown) => {
        const record: { value: Record<string, unknown>; conflict: 'none' | 'nothing' | 'update' } = {
          value: value as Record<string, unknown>,
          conflict: 'none'
        };
        const finish = (kind: string, generatedId?: string) => {
          writes.push({ kind, value: record.value, conflict: record.conflict, generatedId });
        };
        const proceed = {
          onConflictDoNothing: () => {
            record.conflict = 'nothing';
            return {
              returning: async () => {
                const id = (record.value.id as string) ?? crypto.randomUUID();
                finish('event', id);
                return [{ id }];
              },
              then: (resolve: (rows: unknown) => void) => {
                finish('event');
                resolve([]);
              }
            };
          },
          onConflictDoUpdate: (arg: unknown) => {
            record.conflict = 'update';
            finish('fixed-window-counter');
            void arg;
            return Promise.resolve();
          },
          returning: async () => {
            const id = (record.value.id as string) ?? crypto.randomUUID();
            finish(
              isEventWrite(record.value)
                ? 'event'
                : isPromiseWrite(record.value)
                  ? 'promise'
                  : 'unknown-insert',
              id
            );
            return [{ id }];
          },
          then: (resolve: (rows: unknown) => void) => {
            finish(
              isEventWrite(record.value)
                ? 'event'
                : isPromiseWrite(record.value)
                  ? 'promise'
                  : isAuditWrite(record.value)
                    ? 'audit'
                    : 'unknown-insert'
            );
            resolve(undefined);
          }
        };
        return proceed;
      }
    }),
    update: () => ({
      set: (value: unknown) => ({
        where: async () => {
          writes.push({ kind: 'promise-supersede', value: value as Record<string, unknown>, conflict: 'none' });
          return { rowCount: 1 };
        }
      })
    }),
    delete: () => ({ where: async () => ({ rowCount: 0 }) })
  };
  return {
    queue,
    writes,
    shift,
    fakeDb,
    bumpTx: () => {
      txCallbackRuns += 1;
    },
    txRuns: () => txCallbackRuns
  };
});

vi.mock('./db.js', () => ({
  getDb: () => h.fakeDb,
  getPool: () => {
    throw new Error('getPool is not used by sync tests');
  },
  getPooledDb: () => h.fakeDb,
  withTx: (fn: (tx: unknown) => Promise<unknown>) => {
    h.bumpTx();
    return fn(h.fakeDb);
  },
  closePool: async () => undefined
}));

import { app } from './app.js';
import { SESSION_COOKIE } from './sessions.js';

const OFFICER_ID = 'officer-sync-000000000000000000000000001';
const OTHER_OFFICER = 'officer-sync-ZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const BRANCH_ID = 'branch-sync-000000000000000000000000ZZZ';
const LOAN_ID = 'LN-22001';
const event_uuid = () => '11111111-2222-4333-8444-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');

/** The resolveSessionActor join row. */
function sessionRow(over: Record<string, unknown> = {}) {
  return {
    userId: 'user-sync-00000000000000000000000000001',
    username: 'sync-officer',
    role: 'field_officer',
    branchId: BRANCH_ID,
    officerId: OFFICER_ID,
    active: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...over
  };
}

/** The events.ts loan select row (the only loan query made per item). */
function loanRow(over: Record<string, unknown> = {}) {
  return {
    loanId: LOAN_ID,
    assignedOfficerId: OFFICER_ID,
    bucket: '1-30',
    outstanding: 200_000,
    overdueAmount: 50_000,
    ...over
  };
}

/** A stored contact_event row for the duplicate check (payload-comparable fields). */
function storedEventRow(over: Record<string, unknown> = {}) {
  return {
    loanId: LOAN_ID,
    kind: 'CALL',
    outcome: 'paid',
    attemptedAtDevice: new Date(Date.parse('2026-11-06T05:30:00.000Z')),
    deviceTzOffsetMinutes: 330,
    ...over
  };
}

/** Payload for one phone-side event, 11:00 IST on the fixed attempt date. */
function eventPayload(over: Record<string, unknown> = {}) {
  return {
    id: event_uuid(),
    loan_id: LOAN_ID,
    kind: 'CALL',
    outcome: 'paid',
    attempted_at_device: '2026-11-06T05:30:00.000Z', // 11:00 IST
    device_tz_offset_min: 330,
    ...over
  };
}

function cookie() {
  return `${SESSION_COOKIE}=sync-officer-token`;
}

const post = (body: unknown, opts: { cookie?: boolean; session?: Record<string, unknown> } = {}) => {
  // Each request resolves the session first: seed that pop unless the test
  // explicitly asks for an anonymous call.
  if (opts.cookie !== false) {
    h.queue.unshift(sessionRow(opts.session));
  }
  return app.request('/api/events/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.cookie !== false ? { cookie: cookie() } : {}) },
    body: JSON.stringify(body)
  });
};

const eventWrites = () => h.writes.filter((w) => w.kind === 'event');
const auditWrites = () => h.writes.filter((w) => w.kind === 'audit');
const promiseWrites = () => h.writes.filter((w) => w.kind === 'promise');

describe('POST /api/events/batch — gates', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('answers 401 with no session cookie, without touching the db', async () => {
    const res = await post({ events: [eventPayload()] }, { cookie: false });
    expect(res.status).toBe(401);
    expect(h.queue).toHaveLength(0);
  });

  it('refuses managers (assignments are officer-scoped, SPEC 6 sync is officer-only)', async () => {
    const res = await post({ events: [eventPayload()] }, { session: { role: 'branch_manager', officerId: null } });
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(eventWrites()).toHaveLength(0);
  });

  it('400s a non-envelope body and a >20 batch without touching the db', async () => {
    const big = Array.from({ length: 21 }, () => eventPayload());
    let res = await post({ events: big });
    expect(res.status).toBe(400);
    res = await post({ events: 'not-an-array' });
    expect(res.status).toBe(400);
    res = await post({ wrong_key: big.slice(0, 3) });
    expect(res.status).toBe(400);
    expect(h.writes).toHaveLength(0);
  });
});

describe('POST /api/events/batch — idempotency', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('creates a compliant event: one insert, server clock on synced_at, RBC rule set, 11:00 IST', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const res = await post({ events: [eventPayload()] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; status: string; assignmentChanged?: boolean }[]; serverNow: string };
    const item = body.items[0]!;
    expect(item.status).toBe('created');
    expect(item.assignmentChanged).toBe(false);
    expect(typeof body.serverNow).toBe('string');
    const writes = eventWrites();
    expect(writes).toHaveLength(1);
    const value = writes[0]!.value;
    expect(value.attemptedAtDevice).toEqual(new Date(Date.parse('2026-11-06T05:30:00.000Z')));
    expect(value.attemptedAtIst).toEqual(new Date(Date.parse('2026-11-06T05:30:00.000Z'))); // no skew: same instant
    expect(value.syncedAt).toBeInstanceOf(Date); // server clock, NOT the payload's (absent) synced_at
    expect(value.withinWindow).toBe(true);
    expect(value.timeConfidence).toBe('low'); // unknown skew
    expect(value.ruleSet).toBe('RBC2025_para100');
    expect(value.complianceStatus).toBe('COMPLIANT');
    expect(value.officerId).toBe(OFFICER_ID);
  });

  it('duplicate id with the identical payload returns duplicate (the retry case)', async () => {
    // First flush lands the row.
    h.queue.push(loanRow());
    h.queue.push([]);
    const first = await post({ events: [eventPayload()] });
    expect(((await first.json()) as { items: { status: string }[] }).items[0]!.status).toBe('created');

    // Crash-window resend: the server still has the row, the client lost it.
    h.queue.push(loanRow());
    h.queue.push([storedEventRow()]);
    const second = await post({ events: [eventPayload()] });
    const secondBody = (await second.json()) as { items: { status: string; reason?: string }[] };
    expect(secondBody.items[0]!.status).toBe('duplicate');
    expect(secondBody.items[0]!.reason).toBeUndefined();
  });

  it('crash window: a resent batch leaves EXACTLY one row (no second insert, second promise, or promise)', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    await post({ events: [eventPayload()] });
    h.queue.push(loanRow());
    h.queue.push([storedEventRow()]);
    await post({ events: [eventPayload()] });
    expect(eventWrites()).toHaveLength(1); // one row, total
    expect(promiseWrites()).toHaveLength(0);
  });

  it('same id with a DIFFERENT payload keeps the first, logs the mismatch, answers duplicate', async () => {
    const payload = eventPayload();
    h.queue.push(loanRow());
    h.queue.push([]);
    await post({ events: [payload] });

    h.queue.push(loanRow());
    h.queue.push([storedEventRow()]);
    const resend = await post({ events: [{ ...payload, kind: 'VISIT', note: 'edited on the device' }] });
    const body = (await resend.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('duplicate');
    expect(body.items[0]!.reason).toBe('payload_mismatch_kept_first');
    expect(eventWrites()).toHaveLength(1); // first write stands
    const audits = auditWrites();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.value.action).toBe('event_duplicate_mismatch');
    expect(audits[0]!.value.subject).toBe(payload.id);
  });

  it('the retry signature is narrow: device-side skew added later is still the same retry', async () => {
    const payload = eventPayload();
    h.queue.push(loanRow());
    h.queue.push([]);
    await post({ events: [payload] });
    h.queue.push(loanRow());
    h.queue.push([storedEventRow()]);
    const changed = await post({ events: [{ ...payload, skew_estimate_ms: 1000 }] });
    const body = (await changed.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('duplicate');
    expect(body.items[0]!.reason).toBeUndefined(); // plain retry: no mismatch row
    expect(auditWrites()).toHaveLength(0);
  });
});

describe('POST /api/events/batch — partial failure isolation', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('a schema-invalid item is rejected while its siblings still arrive', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const res = await post({
      events: [
        eventPayload({ kind: 'LETTER' }), // bad kind: zod fails, pops nothing
        eventPayload() // good
      ]
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string | null; status: string; reason?: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.status).toBe('rejected');
    expect(body.items[0]!.reason).toContain('invalid_event');
    expect(body.items[1]!.status).toBe('created');
    expect(eventWrites()).toHaveLength(1);
  });

  it('a client synced_at is rejected by name and nothing is written or read', async () => {
    const res = await post({ events: [eventPayload({ synced_at: '2026-11-06T10:00:00Z' })] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('rejected');
    expect(body.items[0]!.reason).toContain('synced_at');
    expect(h.queue).toHaveLength(0); // no query ran
    expect(h.writes).toHaveLength(0); // nothing written
  });

  it('unknown loan and stranger-loan items reject with a named reason, no writes', async () => {
    h.queue.push([]);
    const res = await post({ events: [eventPayload()] });
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('rejected');
    expect(body.items[0]!.reason).toBe('unknown_loan');
    expect(eventWrites()).toHaveLength(0);
  });

  it('a loan not assigned to this officer and absent from history rejects', async () => {
    h.queue.push(loanRow({ assignedOfficerId: OTHER_OFFICER }));
    h.queue.push([]); // no assignment_log row for this officer
    const res = await post({ events: [eventPayload()] });
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.reason).toBe('loan_not_assigned_to_officer');
    expect(eventWrites()).toHaveLength(0);
  });

  it('a loan reassigned while offline is accepted and flagged assignmentChanged', async () => {
    h.queue.push(loanRow({ assignedOfficerId: OTHER_OFFICER }));
    h.queue.push([{ id: 'log-1' }]); // officer appears in the history
    h.queue.push([]);
    const res = await post({ events: [eventPayload()] });
    const body = (await res.json()) as {
      items: { status: string; assignmentChanged?: boolean; complianceStatus?: string }[];
    };
    expect(body.items[0]!.status).toBe('created');
    expect(body.items[0]!.assignmentChanged).toBe(true);
  });
});

describe('POST /api/events/batch — window and confidence derivation (server time)', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('flags a 19:41 IST attempt as VIOLATION_DETECTED and still creates the row', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const res = await post({ events: [eventPayload({ attempted_at_device: '2026-11-06T14:11:00.000Z' })] });
    const body = (await res.json()) as { items: { status: string; complianceStatus?: string }[] };
    const item = body.items[0]!;
    expect(item.status).toBe('created');
    expect(item.complianceStatus).toBe('VIOLATION_DETECTED');
    const value = eventWrites()[0]!.value;
    expect(value.complianceStatus).toBe('VIOLATION_DETECTED');
    expect(value.withinWindow).toBe(false);
  });

  it('cross-checks device time against skew-corrected time: inside device + 83min skew = violation', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    // Device 08:10 IST with +83.3 min skew estimate => true instant 06:46:40
    const res = await post({
      events: [
        eventPayload({ attempted_at_device: '2026-11-06T02:40:00.000Z', skew_estimate_ms: 5_000_000 })
      ]
    });
    const body = (await res.json()) as { items: { status: string; complianceStatus?: string }[] };
    expect(body.items[0]!.status).toBe('created');
    expect(body.items[0]!.complianceStatus).toBe('VIOLATION_DETECTED');
    const value = eventWrites()[0]!.value;
    expect(value.timeConfidence).toBe('low'); // 83 min skew is stale/heavy
    expect(value.attemptedAtIst).toEqual(new Date(Date.parse('2026-11-06T02:40:00.000Z') - 5_000_000));
  });

  it('fresh skew under 5 minutes grades high and the corrected instant is stored', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const res = await post({
      events: [eventPayload({ attempted_at_device: '2026-11-06T04:00:00.000Z', skew_estimate_ms: -4_000 })]
    });
    await res.json();
    const value = eventWrites()[0]!.value;
    expect(value.timeConfidence).toBe('high');
    // skew = serverNow - clientTime, so corrected = device - skew.
    expect(value.attemptedAtIst).toEqual(new Date(Date.parse('2026-11-06T04:00:00.000Z') + 4_000));
  });

  it('a device stamp ahead of the server clock grades suspect without rejecting (backwards clock jump)', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const future = new Date(Date.now() + 3 * 60_000).toISOString();
    const res = await post({ events: [eventPayload({ attempted_at_device: future })] });
    const body = (await res.json()) as { items: { status: string }[] };
    expect(body.items[0]!.status).toBe('created');
    expect(eventWrites()[0]!.value.timeConfidence).toBe('suspect');
  });

  it('stores the rule set of the ATTEMPT date (2026 attempt keeps RBC2025_para100)', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    await post({ events: [eventPayload({ attempted_at_device: '2026-12-31T18:40:00.000Z' })] }); // 00:10 IST 2027-01-01
    const value = eventWrites()[0]!.value;
    expect(value.attemptedAtDevice).toEqual(new Date(Date.parse('2026-12-31T18:40:00.000Z')));
    expect(value.ruleSet).toBe('RECOVERY2026_100Y'); // attempt date is already 2027-01-01 IST
    expect(value.complianceStatus).toBe('VIOLATION_DETECTED'); // 00:10 IST is outside 08:00-19:00
  });
});

describe('POST /api/events/batch — promises (SPEC 12 in the same transaction)', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('a valid promise outcome creates the event AND one promise row inside one transaction', async () => {
    const payload = eventPayload({
      outcome: 'promise_to_pay',
      promised_date: '2026-11-07', // Saturday, inside the +7 window
      promised_amount: 25_000 // exactly half the overdue
    });
    h.queue.push(loanRow());
    h.queue.push([]); // no existing event
    h.queue.push([]); // no open promise
    h.queue.push([]); // no superseded chain
    const res = await post({ events: [payload] });
    const body = (await res.json()) as { items: { status: string }[] };
    expect(body.items[0]!.status).toBe('created');
    expect(eventWrites()).toHaveLength(1);
    const promisesCreated = promiseWrites();
    expect(promisesCreated).toHaveLength(1); // exactly one promise row
    expect(promisesCreated[0]!.value).toMatchObject({
      loanId: LOAN_ID,
      officerId: OFFICER_ID,
      promisedAmount: 25_000,
      promisedDate: '2026-11-07',
      graceDays: 1,
      status: 'open'
    });
    expect(promisesCreated[0]!.value.sourceEventId).toBe(payload.id);
    expect(h.txRuns()).toBeGreaterThan(0); // the pair went through withTx
  });

  it('an amount below half the overdue rejects the item and writes nothing', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    h.queue.push([]);
    h.queue.push([]);
    const res = await post({
      events: [
        eventPayload({
          outcome: 'promise_to_pay',
          promised_date: '2026-11-07',
          promised_amount: 24_999
        })
      ]
    });
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('rejected');
    expect(body.items[0]!.reason).toBe('amount_below_half_overdue');
    expect(h.writes).toHaveLength(0);
  });

  it('the third reschedule is refused (max two per bucket stay)', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    h.queue.push([{ id: 'open-promise' }]); // one open promise: the reschedule target
    h.queue.push([{ id: 's1' }, { id: 's2' }]); // already rescheduled twice
    const res = await post({
      events: [
        eventPayload({ outcome: 'promise_to_pay', promised_date: '2026-11-07', promised_amount: 25_000 })
      ]
    });
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('rejected');
    expect(body.items[0]!.reason).toBe('reschedule_limit_reached');
    expect(h.writes).toHaveLength(0);
  });

  it('a reschedule marks the old promise superseded with the NEW promise id, same transaction', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    h.queue.push([{ id: 'old-promise-id' }]);
    h.queue.push([{ id: 's1' }]); // one reschedule so far
    const res = await post({
      events: [
        eventPayload({ outcome: 'promise_to_pay', promised_date: '2026-11-07', promised_amount: 25_000 })
      ]
    });
    const body = (await res.json()) as { items: { status: string }[] };
    expect(body.items[0]!.status).toBe('created');
    const promiseWrite = promiseWrites()[0]!;
    const supersede = h.writes.find((w) => w.kind === 'promise-supersede')!;
    expect(supersede.value).toMatchObject({ status: 'superseded', supersededBy: promiseWrite.generatedId });
    expect(supersede.value.supersededBy).not.toBe('old-promise-id'); // points at the new row
  });
});

describe('POST /api/events/batch — GPS block rides the same insert', () => {
  beforeEach(() => {
    h.queue.length = 0;
    h.writes.length = 0;
  });

  it('stores a real fix with accuracy', async () => {
    h.queue.push(loanRow());
    h.queue.push([]);
    const res = await post({
      events: [eventPayload({ lat: 22.7196, lng: 75.8577, accuracy_m: 18, gps_status: 'ok' })]
    });
    await res.json();
    expect(eventWrites()[0]!.value).toMatchObject({ lat: 22.7196, lng: 75.8577, accuracyM: 18, gpsStatus: 'ok' });
  });

  it('half a position is a protocol-invalid payload: rejected, nothing written, nothing read', async () => {
    const res = await post({ events: [eventPayload({ lat: 22.7196, gps_status: 'denied' })] });
    const body = (await res.json()) as { items: { status: string; reason?: string }[] };
    expect(body.items[0]!.status).toBe('rejected'); // lat without lng is a fabricated coordinate
    expect(body.items[0]!.reason).toContain('invalid_event');
    expect(h.queue).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });
});
