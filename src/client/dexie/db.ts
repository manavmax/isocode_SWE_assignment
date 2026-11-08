/**
 * Offline-first data layer (SPEC 4/6/16): assignment cache (24 h TTL,
 * wiped on logout), event outbox (SPEC 6 sync), skew estimation (SPEC 7)
 * and reveal cache (SPEC 16) via IndexedDB through Dexie.
 *
 * Wipe on logout: clearCache() removes every table so no stale session
 * data survives a re-login on the same device (SPEC 16 data minimisation).
 * Assignment cache keeps its own 24 h expiry independent of the wipe;
 * the other three tables have no expiry since they are actively managed.
 */
import Dexie, { type Table } from 'dexie';
import type { ContactEventInput } from '../../shared/sync/eventSchema.js';

/** An officer-side contact event waiting to sync (SPEC 6 outbox). */
export interface OutboxItem {
  id: string;
  payload: ContactEventInput;
  state: 'pending' | 'failed' | 'synced';
  attempts: number;
  notBefore: number;
  lastError: string | null;
  createdAt: number;
  syncedAt: number | null;
  warnings: { code: string; reason: string }[] | null;
}

/** Key-value metadata: skew estimate, last sync time, persistence grant. */
export interface MetaRow {
  key: string;
  value: number;
}

/** Revealed phone numbers cached until end of IST day (SPEC 16). */
export interface RevealCacheRow {
  loanId: string;
  phone: string | null;
  altPhone: string | null;
  expiresAt: number;
}

/** Offline assignment list cache — preserved from v1 (24 h TTL). */
export interface CachedAssignments {
  key: 'assignments';
  loans: import('../api.js').AssignmentCard[];
  fetchedAt: number;
}

/** Offline promise-tracker cache (prompt 11 item 5) — same 24 h TTL and
 *  logout wipe as the assignment cache. */
export interface CachedPromises {
  key: 'promises';
  sections: import('../api.js').OfficerPromisesDto;
  fetchedAt: number;
}

/** Offline loan-detail cache (prompt 19.1): the last successfully fetched
 *  LoanDetailDto per loan, so a detail deep-link or reload renders from
 *  cache when offline instead of an error state. */
export interface CachedLoan {
  loanId: string;
  detail: import('../api.js').LoanDetailDto;
  fetchedAt: number;
}

class CollectionsDb extends Dexie {
  outbox!: Table<OutboxItem, string>;
  meta!: Table<MetaRow, string>;
  revealCache!: Table<RevealCacheRow, string>;
  assignments!: Table<CachedAssignments, string>;
  promises!: Table<CachedPromises, string>;
  loans!: Table<CachedLoan, string>;

  constructor() {
    super('field-collections');
    this.version(1).stores({
      assignments: 'key'
    });
    this.version(2).stores({
      outbox: 'id, state, createdAt, notBefore',
      meta: 'key',
      revealCache: 'loanId, expiresAt',
      assignments: 'key'
    });
    this.version(3).stores({
      outbox: 'id, state, createdAt, notBefore',
      meta: 'key',
      revealCache: 'loanId, expiresAt',
      assignments: 'key',
      promises: 'key'
    });
    this.version(4).stores({
      outbox: 'id, state, createdAt, notBefore',
      meta: 'key',
      revealCache: 'loanId, expiresAt',
      assignments: 'key',
      promises: 'key',
      loans: 'loanId'
    });
  }
}

export const db = new CollectionsDb();

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function saveAssignments(loans: import('../api.js').AssignmentCard[], fetchedAt = Date.now()): Promise<void> {
  await db.assignments.put({ key: 'assignments', loans, fetchedAt });
}

export async function loadAssignments(): Promise<CachedAssignments | undefined> {
  const cached = await db.assignments.get('assignments');
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    await db.assignments.delete('assignments');
    return undefined;
  }
  return cached;
}

/** Loan-detail cache: same 24 h expiry and logout wipe as assignments. */
export async function saveLoan(detail: import('../api.js').LoanDetailDto, fetchedAt = Date.now()): Promise<void> {
  await db.loans.put({ loanId: detail.loanId, detail, fetchedAt });
}

export async function loadLoan(loanId: string): Promise<CachedLoan | undefined> {
  const cached = await db.loans.get(loanId);
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    await db.loans.delete(loanId);
    return undefined;
  }
  return cached;
}

/** The cached worklist card for one loan — the offline fallback when the
 *  full detail was never fetched (prompt 19.1: render what the worklist
 *  cache has, mark the rest unavailable). */
export async function loadAssignmentCard(loanId: string): Promise<import('../api.js').AssignmentCard | undefined> {
  const cached = await loadAssignments();
  return cached?.loans.find((loan) => loan.loanId === loanId);
}

/** Promise-tracker cache: same 24 h expiry and logout wipe as assignments. */
export async function savePromises(sections: import('../api.js').OfficerPromisesDto, fetchedAt = Date.now()): Promise<void> {
  await db.promises.put({ key: 'promises', sections, fetchedAt });
}

export async function loadPromises(): Promise<CachedPromises | undefined> {
  const cached = await db.promises.get('promises');
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    await db.promises.delete('promises');
    return undefined;
  }
  return cached;
}

/** Meta helpers */
export const META_KEYS = {
  SKEW_ESTIMATE_MS: 'skew_estimate_ms',
  LAST_SYNC_AT: 'last_sync_at',
  PERSISTED: 'persisted',
  LAST_OUTCOME_KIND: 'last_outcome_kind'
} as const;

export async function getMeta(key: string): Promise<number | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: number): Promise<void> {
  await db.meta.put({ key, value });
}

export async function getSkew(): Promise<number> {
  return (await getMeta(META_KEYS.SKEW_ESTIMATE_MS)) ?? 0;
}

export async function getLastSyncAt(): Promise<number | null> {
  return getMeta(META_KEYS.LAST_SYNC_AT);
}

export async function setLastSyncAt(ts: number): Promise<void> {
  return setMeta(META_KEYS.LAST_SYNC_AT, ts);
}

/**
 * SPEC 6 platform limits: call navigator.storage.persist() after the first
 * save and remember the answer. Returns true/false once the browser has
 * answered, null while unsupported/unavailable; the Sync screen warns when
 * the answer is false while items are pending.
 */
export async function ensurePersistence(): Promise<boolean | null> {
  const stored = await getMeta(META_KEYS.PERSISTED);
  if (stored !== null) return stored === 1;
  let granted: boolean | null = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      granted = await navigator.storage.persist();
    }
  } catch {
    granted = null;
  }
  if (granted !== null) {
    await setMeta(META_KEYS.PERSISTED, granted ? 1 : 0);
  }
  return granted;
}

/** Reveal cache helpers */
export async function getCachedReveal(loanId: string): Promise<RevealCacheRow | null> {
  const row = await db.revealCache.get(loanId);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    await db.revealCache.delete(loanId);
    return null;
  }
  return row;
}

export async function setCachedReveal(loanId: string, phone: string | null, altPhone: string | null): Promise<void> {
  const now = Date.now();
  const p = istDateParts(now);
  const todayKey = `${String(p.year)}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
  const tomorrowKey = addIstDays(todayKey, 1);
  const expiresAt = Date.parse(`${tomorrowKey}T00:00:00Z`) - 330 * 60_000;
  await db.revealCache.put({ loanId, phone, altPhone, expiresAt });
}

function istDateParts(utcMs: number) {
  const IST = 330;
  const shifted = new Date(utcMs + IST * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function addIstDays(dateKey: string, days: number): string {
  const shifted = new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** Outbox helpers */
export async function queueEvent(payload: ContactEventInput, holdMs = 0): Promise<string> {
  const now = Date.now();
  await db.outbox.put({
    id: payload.id,
    payload,
    state: 'pending',
    attempts: 0,
    notBefore: now + holdMs,
    lastError: null,
    createdAt: now,
    syncedAt: null,
    warnings: null
  });
  // SPEC 6 platform limits: request persistent storage after the first save
  // so Safari/WebView eviction cannot eat a queued compliance record.
  void ensurePersistence();
  return payload.id;
}

export async function getPendingItems(limit: number, nowFn: () => number): Promise<OutboxItem[]> {
  const now = nowFn();
  const items = await db.outbox
    .where('state')
    .equals('pending')
    .and((item) => item.notBefore <= now)
    .sortBy('createdAt');
  return items.slice(0, limit);
}

export async function getOutboxCounts(): Promise<{ pending: number; failed: number; synced: number }> {
  const all = await db.outbox.toArray();
  return {
    pending: all.filter((i) => i.state === 'pending').length,
    failed: all.filter((i) => i.state === 'failed').length,
    synced: all.filter((i) => i.state === 'synced').length
  };
}

export async function getOutboxItems(limit = 50): Promise<OutboxItem[]> {
  const all = await db.outbox.orderBy('createdAt').reverse().limit(limit).toArray();
  return all;
}

export async function markSynced(id: string, warnings: { code: string; reason: string }[] | null): Promise<void> {
  await db.outbox.update(id, { state: 'synced', syncedAt: Date.now(), warnings });
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db.outbox.update(id, { state: 'failed', lastError: error });
}

export async function retryItem(id: string): Promise<void> {
  const item = await db.outbox.get(id);
  if (!item || item.state !== 'failed') return;
  await db.outbox.update(id, { state: 'pending', lastError: null, notBefore: Date.now() });
}

export async function discardItem(id: string): Promise<void> {
  await db.outbox.delete(id);
}

export async function undoItem(id: string, nowFn: () => number): Promise<boolean> {
  const item = await db.outbox.get(id);
  if (!item) return false;
  if (nowFn() >= item.notBefore) return false;
  await db.outbox.delete(id);
  return true;
}

export async function setBackoff(id: string, notBefore: number, attempts: number, error: string): Promise<void> {
  await db.outbox.update(id, { notBefore, attempts, lastError: error });
}

export async function cleanupSynced(keepMs: number): Promise<void> {
  const cutoff = Date.now() - keepMs;
  await db.outbox.where('state').equals('synced').and((i) => (i.syncedAt ?? 0) < cutoff).delete();
}

export async function clearCache(): Promise<void> {
  await Promise.all([
    db.outbox.clear(),
    db.meta.clear(),
    db.revealCache.clear(),
    db.assignments.clear(),
    db.promises.clear(),
    db.loans.clear()
  ]);
}
