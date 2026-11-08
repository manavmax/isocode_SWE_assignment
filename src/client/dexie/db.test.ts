/**
 * Dexie layer tests (prompt 10b client, fake-indexeddb): outbox states and
 * holds, Undo only before not_before, retry/discard, synced retention for
 * the Sync screen, reveal-cache expiry at the end of the IST day (A59),
 * the logout wipe and the assignment cache's independent 24 h TTL.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  CACHE_TTL_MS,
  saveAssignments,
  loadPromises,
  savePromises,
  loadAssignments,
  getMeta,
  setMeta,
  getSkew,
  META_KEYS,
  getCachedReveal,
  setCachedReveal,
  queueEvent,
  getPendingItems,
  getOutboxCounts,
  getOutboxItems,
  markSynced,
  retryItem,
  discardItem,
  undoItem,
  setBackoff,
  cleanupSynced,
  clearCache,
  ensurePersistence,
  type OutboxItem
} from './db.js';
import { validContactEventInput, type ContactEventInput } from '../../shared/sync/eventSchema.js';

function payload(id: string, overrides: Partial<ContactEventInput> = {}): ContactEventInput {
  return validContactEventInput({ id, loan_id: 'LN-10001', ...overrides });
}

/** Write an outbox row with explicit timestamps (ordering/age control). */
async function putRaw(item: Partial<OutboxItem> & { id: string }): Promise<void> {
  const existing = await db.outbox.get(item.id);
  await db.outbox.put({
    payload: payload(item.id),
    state: 'pending',
    attempts: 0,
    notBefore: 0,
    lastError: null,
    createdAt: 0,
    syncedAt: null,
    warnings: null,
    ...existing,
    ...item
  } as OutboxItem);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await db.delete();
});

describe('outbox queue (SPEC 6: write to Dexie BEFORE any network call)', () => {
  it('an event queues pending with a 5 s undo hold and is invisible to flush until the hold passes', async () => {
    const id = await queueEvent(payload('e1'), 5_000);
    expect(id).toBe('e1');
    // Right now: held.
    expect(await getPendingItems(20, () => Date.now())).toHaveLength(0);
    // After the hold: flushable.
    const items = await getPendingItems(20, () => Date.now() + 5_001);
    expect(items).toHaveLength(1);
    expect(items[0]!.state).toBe('pending');
    expect(items[0]!.attempts).toBe(0);
  });

  it('getPendingItems returns only pending items past not_before, oldest first, capped', async () => {
    for (let i = 0; i < 3; i++) {
      await putRaw({ id: `old-${i}`, createdAt: 1_000 + i });
    }
    await putRaw({ id: 'failed', state: 'failed', createdAt: 900 });
    await putRaw({ id: 'held', createdAt: 500, notBefore: Date.now() + 60_000 });
    await putRaw({ id: 'synced', state: 'synced', createdAt: 400 });

    const items = await getPendingItems(20, () => Date.now());
    expect(items.map((i) => i.id)).toEqual(['old-0', 'old-1', 'old-2']);
  });

  it('respects the batch cap (oldest 20 of many)', async () => {
    for (let i = 0; i < 25; i++) {
      await putRaw({ id: `e-${String(i).padStart(2, '0')}`, createdAt: i });
    }
    const first = await getPendingItems(20, () => Date.now());
    expect(first).toHaveLength(20);
    expect(first[0]!.id).toBe('e-00');
    expect(first[19]!.id).toBe('e-19');
  });

  it('counts pending, failed and synced for the pill and the Sync section', async () => {
    await putRaw({ id: 'a' });
    await putRaw({ id: 'b', state: 'failed' });
    await putRaw({ id: 'c', state: 'synced', syncedAt: Date.now() });
    expect(await getOutboxCounts()).toEqual({ pending: 1, failed: 1, synced: 1 });
  });
});

describe('Undo, Retry, Discard (SPEC 6: never retried or deleted blindly)', () => {
  it('Undo removes an item only before its not_before', async () => {
    const id = await queueEvent(payload('u1'), 5_000);
    // Within the 5 s hold: undo works.
    expect(await undoItem(id, () => Date.now() + 1_000)).toBe(true);
    expect(await db.outbox.get(id)).toBeUndefined();

    // After the hold the item is flushable — Undo must refuse (it may have
    // reached the server already).
    const id2 = await queueEvent(payload('u2'), 0);
    expect(await undoItem(id2, () => Date.now() + 60_000)).toBe(false);
    expect(await db.outbox.get(id2)).toBeDefined();
  });

  it('Retry re-queues a failed item and clears the error; Discard deletes it', async () => {
    await putRaw({ id: 'f1', state: 'failed', lastError: 'http_422' });
    await retryItem('f1');
    const retried = await db.outbox.get('f1');
    expect(retried!.state).toBe('pending');
    expect(retried!.lastError).toBeNull();
    expect(retried!.notBefore).toBeLessThanOrEqual(Date.now());

    await discardItem('f1');
    expect(await db.outbox.get('f1')).toBeUndefined();
  });

  it('Retry never resurrects a pending or synced item', async () => {
    await putRaw({ id: 'p1', state: 'pending' });
    await putRaw({ id: 's1', state: 'synced', syncedAt: Date.now() });
    await retryItem('p1');
    await retryItem('s1');
    expect((await db.outbox.get('p1'))!.state).toBe('pending');
    expect((await db.outbox.get('s1'))!.state).toBe('synced');
  });
});

describe('synced retention (prompt 10b: keep synced items 24 h for the Sync screen)', () => {
  it('markSynced keeps the row with its warnings; cleanup drops only items older than 24 h', async () => {
    await queueEvent(payload('w1'));
    await markSynced('w1', [{ code: 'promise_not_created', reason: 'date_is_sunday' }]);
    const kept = await getOutboxItems();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.state).toBe('synced');
    expect(kept[0]!.warnings).toEqual([{ code: 'promise_not_created', reason: 'date_is_sunday' }]);
    expect(kept[0]!.syncedAt).not.toBeNull();

    // An item synced 25 h ago goes; the fresh one stays.
    await putRaw({ id: 'ancient', state: 'synced', syncedAt: Date.now() - 25 * 3600_000 });
    await cleanupSynced(24 * 3600_000);
    const after = await getOutboxItems();
    expect(after.map((i) => i.id).sort()).toEqual(['w1']);
  });

  it('backoff rows keep their attempts count and last error for the Sync screen', async () => {
    await putRaw({ id: 'b1' });
    await setBackoff('b1', Date.now() + 30_000, 3, 'http_503');
    const row = await db.outbox.get('b1');
    expect(row!.attempts).toBe(3);
    expect(row!.lastError).toBe('http_503');
    expect(row!.state).toBe('pending');
  });
});

describe('reveal cache (A59: unmasked number lives until the end of the IST day)', () => {
  it('expires exactly at the next IST midnight', async () => {
    // 19:30 IST on 2026-11-06 → the cache must die at 2026-11-06T18:30:00Z
    // (00:00 IST on 2026-11-07).
    const evening = Date.parse('2026-11-06T14:00:00Z');
    const realNow = Date.now;
    Date.now = () => evening;
    try {
      await setCachedReveal('LN-9', '9876543210', null);
      const row = await db.revealCache.get('LN-9');
      expect(row!.expiresAt).toBe(Date.parse('2026-11-07T00:00:00Z') - 330 * 60_000);

      // Just before midnight IST (23:29 IST = 17:59Z): still readable.
      Date.now = () => evening + (3 * 3600 + 59 * 60) * 1000;
      expect(await getCachedReveal('LN-9')).not.toBeNull();

      // Past expiry: dropped.
      Date.now = () => row!.expiresAt + 1;
      expect(await getCachedReveal('LN-9')).toBeNull();
      expect(await db.revealCache.get('LN-9')).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('meta (SPEC 7 skew, last sync, persistence)', () => {
  it('round-trips the skew estimate and defaults to zero', async () => {
    expect(await getSkew()).toBe(0);
    await setMeta(META_KEYS.SKEW_ESTIMATE_MS, -42_000);
    expect(await getSkew()).toBe(-42_000);
    expect(await getMeta('nope')).toBeNull();
  });

  it('ensurePersistence asks once, remembers the answer and never asks again', async () => {
    const persist = vi.fn(async () => false);
    const realStorage = navigator.storage;
    Object.defineProperty(navigator, 'storage', { value: { persist }, configurable: true });
    try {
      expect(await ensurePersistence()).toBe(false);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(await getMeta(META_KEYS.PERSISTED)).toBe(0);
      // Second call answers from meta without touching the browser again.
      expect(await ensurePersistence()).toBe(false);
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'storage', { value: realStorage, configurable: true });
    }
  });
});

describe('logout wipe and assignment cache TTL (SPEC 16)', () => {
  it('clearCache wipes outbox, meta, reveal cache, the assignment cache and the promise cache', async () => {
    await queueEvent(payload('x1'));
    await setMeta(META_KEYS.SKEW_ESTIMATE_MS, 1_000);
    await setCachedReveal('LN-1', '9876543210', null);
    await saveAssignments([], Date.now());
    await savePromises({ dueToday: [], upcoming: [], brokenNeedingFollowup: [] }, Date.now());
    await clearCache();
    expect(await getOutboxCounts()).toEqual({ pending: 0, failed: 0, synced: 0 });
    expect(await getSkew()).toBe(0);
    expect(await db.revealCache.count()).toBe(0);
    expect(await loadAssignments()).toBeUndefined();
    expect(await loadPromises()).toBeUndefined(); // the promise cache dies with the session too
  });

  it('the assignment cache keeps its own 24 h expiry, independent of the wipe', async () => {
    await saveAssignments([{ loanId: 'LN-1' } as never], Date.now() - 23 * 3600_000);
    expect((await loadAssignments())!.loans).toHaveLength(1);

    await saveAssignments([{ loanId: 'LN-1' } as never], Date.now() - CACHE_TTL_MS - 1);
    expect(await loadAssignments()).toBeUndefined();
    // The stale row is deleted, not just ignored.
    expect(await db.assignments.get('assignments')).toBeUndefined();
  });
});
