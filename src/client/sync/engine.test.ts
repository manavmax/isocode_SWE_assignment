/**
 * Outbox flush engine tests (prompt 10b client): fake-indexeddb for the
 * queue, injected fetch / clock / random so every response code, backoff
 * step and ordering rule is deterministic (SPEC 6 required tests).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureEngine,
  estimateSkew,
  correctedNowMs,
  flush,
  isLoginRequired,
  resetBackoff,
  resetLoginRequired
} from './engine.js';
import { db, queueEvent, getOutboxCounts, getOutboxItems, getSkew } from '../dexie/db.js';
import { validContactEventInput, type ContactEventInput } from '../../shared/sync/eventSchema.js';

interface Clock {
  now: number;
}

interface EngineEnv {
  clock: Clock;
  random: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  authRequired: ReturnType<typeof vi.fn>;
}

let env: EngineEnv;

function makeEnv(): void {
  const clock: Clock = { now: Date.now() };
  const random = vi.fn(() => 0); // jitter = exactly half of each backoff step
  const fetchMock = vi.fn();
  const authRequired = vi.fn();
  configureEngine({
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock.now,
    random: () => random(),
    batchSize: 20,
    timeoutMs: 15_000,
    baseBackoffMs: 2_000,
    maxBackoffMs: 300_000,
    onAuthRequired: authRequired
  });
  env = { clock, random, fetchMock, authRequired };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function itemResult(id: string, status: 'created' | 'duplicate' | 'rejected', extra: object = {}): object {
  return { id, status, ...extra };
}

async function queue(payloadOverrides: Partial<ContactEventInput> = {}): Promise<string> {
  // A fresh UUID per call: the shared fixture helper's default id is a
  // constant, and Dexie would collapse same-id puts into one row. The row's
  // clock fields are then pinned to the FAKE timeline — monotonic createdAt
  // (strict ordering) and notBefore 0 (always flushable) — so no test can
  // flake on millisecond collisions between the real and fake clocks.
  const id = crypto.randomUUID();
  await queueEvent(validContactEventInput({ id, loan_id: 'LN-10001', ...payloadOverrides }));
  env.clock.now = Math.max(env.clock.now, Date.now()) + 1;
  await db.outbox.update(id, { notBefore: 0, createdAt: env.clock.now });
  return id;
}

/** Server-side grading for the batch, as events.ts would answer. */
function batchResponse(events: ContactEventInput[], status: 'created' | 'duplicate' = 'created'): unknown {
  return {
    items: events.map((e) => itemResult(e.id, status)),
    serverNow: new Date(5_000_000).toISOString()
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await db.delete();
  resetBackoff();
  resetLoginRequired();
  configureEngine({
    fetch: undefined,
    now: undefined,
    random: undefined,
    batchSize: undefined,
    timeoutMs: undefined,
    baseBackoffMs: undefined,
    maxBackoffMs: undefined,
    onAuthRequired: undefined
  } as never);
});

describe('response grading (SPEC 6: created AND duplicate are success)', () => {
  it('created marks the item synced and stores per-item warnings (promise_not_created, A57)', async () => {
    makeEnv();
    const id = await queue({ outcome: 'promise_to_pay', promised_date: '2026-11-08', promised_amount: 100_000 });
    env.fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        items: [itemResult(id, 'created', { warnings: [{ code: 'promise_not_created', reason: 'date_is_sunday' }] })],
        serverNow: new Date(5_000_000).toISOString()
      })
    );
    const result = await flush();
    expect(result.kind).toBe('synced');
    expect(result.sent).toBe(1);
    const counts = await getOutboxCounts();
    expect(counts).toEqual({ pending: 0, failed: 0, synced: 1 });
    const item = (await getOutboxItems())[0]!;
    expect(item.state).toBe('synced');
    expect(item.warnings).toEqual([{ code: 'promise_not_created', reason: 'date_is_sunday' }]);
  });

  it('duplicate counts as success — the crash window ends consistent (resend returns duplicate)', async () => {
    makeEnv();
    const id = await queue();
    // Flush 1: the server ACCEPTS the event, but the client crashes before
    // marking synced — the response never reaches the state update.
    env.fetchMock.mockImplementationOnce(async () => {
      env.clock.now += 10;
      return jsonResponse(200, batchResponse(await currentPayloads()));
    });
    const first = await flush();
    // Simulate the crash: the response arrived but the item is still pending.
    await db.outbox.update(id, { state: 'pending', syncedAt: null });
    expect(first.kind).toBe('synced');

    // Flush 2 (the retry after restart): same id, same payload → duplicate.
    env.fetchMock.mockResolvedValueOnce(jsonResponse(200, batchResponse([{ id } as ContactEventInput], 'duplicate')));
    const second = await flush();
    expect(second.kind).toBe('synced');
    expect(second.sent).toBe(1);

    // Exactly one server row exists (the duplicate was not re-inserted) and
    // the outbox is consistent: one synced item, nothing pending.
    const bodies = env.fetchMock.mock.calls.map((c) => JSON.parse(c[1]!.body as string));
    expect(bodies[0]!.events[0].id).toBe(bodies[1]!.events[0].id);
    const counts = await getOutboxCounts();
    expect(counts).toEqual({ pending: 0, failed: 0, synced: 1 });
  });
});

describe('failure paths (SPEC 6: 4xx never retried, network errors are)', () => {
  it('a 4xx marks the item failed with Retry/Discard — and the next flush sends nothing', async () => {
    makeEnv();
    await queue();
    env.fetchMock.mockResolvedValueOnce(jsonResponse(422, { error: 'bad' }));
    const result = await flush();
    expect(result.kind).toBe('server');
    expect(result.failed).toBe(1);
    expect((await getOutboxItems())[0]!.state).toBe('failed');
    expect((await getOutboxItems())[0]!.lastError).toBe('http_422');

    const calls = env.fetchMock.mock.calls.length;
    const again = await flush();
    expect(again.kind).toBe('idle');
    expect(env.fetchMock.mock.calls.length).toBe(calls); // no blind retry
  });

  it('a per-item rejection fails only that item (partial batch)', async () => {
    makeEnv();
    const good = await queue({ loan_id: 'LN-10001' });
    const bad = await queue({ loan_id: 'LN-10002' });
    env.fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        items: [itemResult(good, 'created'), itemResult(bad, 'rejected', { reason: 'unknown_loan' })],
        serverNow: new Date(5_000_000).toISOString()
      })
    );
    const result = await flush();
    expect(result.kind).toBe('synced');
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const rows = await getOutboxItems();
    const goodRow = rows.find((r) => r.id === good)!;
    const badRow = rows.find((r) => r.id === bad)!;
    expect(goodRow.state).toBe('synced');
    expect(badRow.state).toBe('failed');
    expect(badRow.lastError).toBe('unknown_loan');
  });

  it('401 keeps the whole outbox pending and raises the re-login signal', async () => {
    makeEnv();
    await queue();
    env.fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }));
    const result = await flush();
    expect(result.kind).toBe('unauthorized');
    expect(env.authRequired).toHaveBeenCalledTimes(1);
    expect(isLoginRequired()).toBe(true);
    // The queue survives untouched (SPEC 6: expired session offline).
    expect(await getOutboxCounts()).toEqual({ pending: 1, failed: 0, synced: 0 });
  });
});

describe('network errors and backoff (2 s doubling, jitter, 5 min cap, reset)', () => {
  it('a network error keeps items pending with an exponentially growing not_before', async () => {
    makeEnv();
    await queue();
    env.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    let result = await flush();
    expect(result.kind).toBe('network');
    let item = (await getOutboxItems())[0]!;
    // random=0 → jitter = half of the step; step 1 = 2 s * 2^1 → wait 2 s.
    expect(item.attempts).toBe(1);
    expect(item.notBefore - env.clock.now).toBe(2_000);
    expect(item.lastError).toBe('network');

    // Second failure: step 2 → 8 s * 2^2 → wait 4 s.
    env.clock.now += 60_000;
    env.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await flush();
    item = (await getOutboxItems())[0]!;
    expect(item.attempts).toBe(2);
    expect(item.notBefore - env.clock.now).toBe(4_000);

    // The item is invisible to flush until not_before passes.
    env.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    env.clock.now += 1_000;
    result = await flush();
    expect(result.kind).toBe('idle');
  });

  it('a timeout (AbortError) takes the retry path too', async () => {
    makeEnv();
    await queue();
    env.fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const result = await flush();
    expect(result.kind).toBe('network');
    const item = (await getOutboxItems())[0]!;
    expect(item.lastError).toBe('timeout');
    expect(item.attempts).toBe(1);
  });

  it('429 and 5xx use the backoff path, not the failed state', async () => {
    makeEnv();
    await queue();
    env.fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    await flush();
    const item = (await getOutboxItems())[0]!;
    expect(item.state).toBe('pending');
    expect(item.lastError).toBe('http_503');

    // After the backoff passes, a success clears the item AND the schedule.
    env.clock.now += 60_000;
    env.fetchMock.mockResolvedValueOnce(jsonResponse(200, batchResponse(await currentPayloads())));
    const result = await flush();
    expect(result.kind).toBe('synced');
    expect(await getOutboxCounts().then((c) => c.synced)).toBe(1);
  });

  it('backoff caps at 5 minutes and resets after online/foreground (resetBackoff)', async () => {
    makeEnv();
    await queue();
    // Drive the multiplier past the cap.
    for (let i = 0; i < 12; i++) {
      env.clock.now += 600_000;
      env.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await flush();
    }
    let item = (await getOutboxItems())[0]!;
    const cappedWait = item.notBefore - env.clock.now;
    expect(cappedWait).toBe(150_000); // half of the 300 000 ms cap (random=0)
    expect(item.lastError).toBe('network');

    resetBackoff();
    env.clock.now += 600_000;
    env.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await flush();
    item = (await getOutboxItems())[0]!;
    expect(item.notBefore - env.clock.now).toBe(2_000); // back to step 1
  });
});

describe('single-flight and ordering (SPEC 6.2/6.3)', () => {
  it('concurrent flush() calls share ONE request', async () => {
    makeEnv();
    await queue();
    let release!: (v: Response) => void;
    env.fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      })
    );
    const p1 = flush();
    const p2 = flush();
    const p3 = flush();
    release(jsonResponse(200, batchResponse(await currentPayloads())));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(env.fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.kind).toBe('synced');
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('flush sends the oldest 20 first, then the rest', async () => {
    makeEnv();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      ids.push(await queue());
      // Strictly increasing createdAt: Date.now() has ms resolution, so give
      // each row its own millisecond.
      await new Promise((r) => setTimeout(r, 2));
    }
    env.fetchMock.mockResolvedValueOnce(jsonResponse(200, batchResponse(await currentPayloads())));
    const first = await flush();
    expect(first.sent).toBe(20);
    const firstBody = JSON.parse(env.fetchMock.mock.calls[0]![1]!.body as string);
    expect(firstBody.events).toHaveLength(20);

    env.fetchMock.mockResolvedValueOnce(jsonResponse(200, batchResponse(await currentPayloads())));
    const second = await flush();
    expect(second.sent).toBe(2);
    const secondBody = JSON.parse(env.fetchMock.mock.calls[1]![1]!.body as string);
    expect(secondBody.events).toHaveLength(2);
    // The two batches interleave in queue order (oldest → newest).
    const allIds = [...firstBody.events.map((e: { id: string }) => e.id), ...secondBody.events.map((e: { id: string }) => e.id)];
    expect(allIds).toEqual(ids);
  });
});

describe('clock skew from serverNow (SPEC 7 / A58)', () => {
  it('stores skew = midpoint − serverNow so the server can correct device − skew', async () => {
    makeEnv();
    await queue();
    // t_sent = clock.now; the fetch advances the fake clock by 2 000 ms.
    env.fetchMock.mockImplementationOnce(async () => {
      env.clock.now += 2_000;
      return jsonResponse(200, batchResponse(await currentPayloads()));
    });
    await flush();
    // midpoint = t_sent + 1 000; serverNow = 5 000 000 (1970 — far behind).
    expect(await getSkew()).toBe(env.clock.now - 1_000 - 5_000_000);
  });

  it('the sign convention: a fast device yields positive skew and device − skew lands on true time', () => {
    const trueNow = 1_800_000_000_000;
    const deviceNow = trueNow + 120_000; // device runs 2 min FAST
    const skew = estimateSkew(trueNow, deviceNow, deviceNow);
    expect(skew).toBe(120_000);
    expect(correctedNowMs(deviceNow, skew)).toBe(trueNow);
  });
});

async function currentPayloads(): Promise<ContactEventInput[]> {
  return (await db.outbox.toArray()).filter((i) => i.state === 'pending').map((i) => i.payload);
}
