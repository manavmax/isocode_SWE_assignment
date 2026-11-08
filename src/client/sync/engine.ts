/**
 * Outbox flush engine (SPEC 6): writes to Dexie BEFORE any network call
 * (queueEvent does that; this module only sends), single-flights concurrent
 * flush() calls, batches the oldest 20 pending items whose not_before has
 * passed, sends to POST /api/events/batch, handles all response codes,
 * updates item states, manages exponential backoff with jitter, and stores
 * the clock skew from the server response (SPEC 7).
 *
 * Backoff: 2 s doubling with jitter (half..full of the step), 5 min cap,
 * global multiplier reset on online/foreground (resetBackoff). 401 keeps the
 * whole outbox and raises onAuthRequired — the officer logs in again, the
 * queue is never wiped (SPEC 6: expired session offline). 4xx marks items
 * failed (visible Retry/Discard, never blindly retried). 429/5xx/timeout/
 * network errors set per-item not_before and stay pending. `created` AND
 * `duplicate` both count as success (SPEC 6), and per-item warnings (e.g.
 * promise_not_created, A57) are stored so the Sync screen can show them.
 *
 * All effects are injectable (fetch, clock, random, auth-required sink) so
 * the whole schedule is testable without a browser or network.
 */
import { contactEventBatchSchema } from '../../shared/sync/eventSchema.js';
import type { BatchItemResult } from '../../server/events.js';
import {
  getPendingItems,
  markSynced,
  markFailed,
  setBackoff,
  cleanupSynced,
  setMeta,
  META_KEYS,
  setLastSyncAt
} from '../dexie/db.js';

export interface SyncResult {
  kind: 'idle' | 'synced' | 'network' | 'unauthorized' | 'server' | 'schema_error';
  sent: number;
  failed: number;
  serverNow: string | null;
}

export interface EngineDeps {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  batchSize?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Raised on a 401: keep the outbox, ask the officer to log in again. */
  onAuthRequired?: () => void;
}

const DEFAULTS: Required<EngineDeps> = {
  // bound: the engine calls d().fetch(...) as a method of the deps object,
  // and the native fetch throws Illegal invocation unless its receiver is
  // the window (prompt 19: every in-browser flush failed on this and the
  // outbox never synced — unit tests missed it because they inject fetch).
  fetch: fetch.bind(globalThis),
  now: Date.now,
  random: () => Math.random(),
  batchSize: 20,
  timeoutMs: 15_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 300_000,
  onAuthRequired: () => window.dispatchEvent(new Event('fc:auth-required'))
};

let _deps: Required<EngineDeps> = { ...DEFAULTS };
let _inFlight: Promise<SyncResult> | null = null;
let _globalAttempts = 0;
let _loginRequired = false;

export function configureEngine(deps: Partial<EngineDeps>): void {
  _deps = { ..._deps, ...deps };
}

function d(): Required<EngineDeps> {
  return _deps;
}

export function isLoginRequired(): boolean {
  return _loginRequired;
}

export function resetLoginRequired(): void {
  _loginRequired = false;
}

function _jitter(delayMs: number): number {
  return Math.round(delayMs / 2 + d().random() * (delayMs / 2));
}

function _backoffDelay(): number {
  const { baseBackoffMs, maxBackoffMs } = d();
  return Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, _globalAttempts));
}

/** Estimate clock skew from a serverNow reading.
 * Convention (A58 / A52): skew_estimate_ms = device error = how much the
 * device clock is FAST of true time (positive = device ahead). The server
 * corrects via device − skew. This is the NEGATION of SPEC 7's
 * "serverNow − midpoint" formula — the negation makes the server's
 * device − skew correction land on true time. Formula:
 *   skew = (tSent + tReceived)/2 − serverNowMs
 * Verified by: fast device clock → positive skew → server subtracts → correct. */
export function estimateSkew(serverNowMs: number, tSentMs: number, tReceivedMs: number): number {
  return (tSentMs + tReceivedMs) / 2 - serverNowMs;
}

/** True now, best estimate: the device clock minus its error (A58). The
 * stored skew is the device error (positive = device fast), so the window
 * check runs on device − skew, matching the server's attempted_at_ist. */
export function correctedNowMs(deviceNowMs: number, skewEstimateMs: number): number {
  return deviceNowMs - skewEstimateMs;
}

/** Main flush: single-flights concurrent calls (SPEC 6). */
export async function flush(): Promise<SyncResult> {
  if (_inFlight) return _inFlight;
  _inFlight = _doFlush();
  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

async function _doFlush(): Promise<SyncResult> {
  const now = d().now;
  const { batchSize } = d();

  // Opportunistic cleanup of synced items older than 24 h (Sync screen keep).
  await cleanupSynced(24 * 60 * 60_000);

  const items = await getPendingItems(batchSize, now);
  if (items.length === 0) {
    return { kind: 'idle', sent: 0, failed: 0, serverNow: null };
  }

  const payloads = items.map((i) => i.payload);

  // Defensive: validate the envelope shape before sending. Payloads come
  // from schema-validated writes, so a failure here is a client bug — fail
  // the items visibly (Retry/Discard) instead of parking them forever.
  const parsed = contactEventBatchSchema.safeParse({ events: payloads });
  if (!parsed.success) {
    await Promise.all(items.map((item) => markFailed(item.id, 'schema_error')));
    _globalAttempts = 0;
    return { kind: 'schema_error', sent: 0, failed: items.length, serverNow: null };
  }

  const tSent = now();
  let res: Response;
  try {
    res = await d().fetch('/api/events/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ events: payloads }),
      signal: AbortSignal.timeout(d().timeoutMs)
    });
  } catch (err) {
    const kind = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      ? 'timeout'
      : 'network';
    await _handleNetworkError(items, kind, now);
    return { kind: 'network', sent: items.length, failed: 0, serverNow: null };
  }
  const tReceived = now();

  // 401: keep the whole outbox, require re-login (SPEC 6).
  if (res.status === 401) {
    _loginRequired = true;
    d().onAuthRequired();
    return { kind: 'unauthorized', sent: items.length, failed: 0, serverNow: null };
  }

  // 429 / 5xx: retry with backoff.
  if (res.status === 429 || res.status >= 500) {
    await _handleNetworkError(items, `http_${res.status}`, now);
    return { kind: 'network', sent: items.length, failed: 0, serverNow: null };
  }

  // Other 4xx: mark items failed — no auto-retry.
  if (!res.ok) {
    await Promise.all(items.map((item) => markFailed(item.id, `http_${res.status}`)));
    _globalAttempts = 0;
    await setLastSyncAt(now());
    return { kind: 'server', sent: 0, failed: items.length, serverNow: null };
  }

  let body: { items: BatchItemResult[]; serverNow: string };
  try {
    body = (await res.json()) as { items: BatchItemResult[]; serverNow: string };
  } catch {
    await _handleNetworkError(items, 'invalid_json', now);
    return { kind: 'network', sent: items.length, failed: 0, serverNow: null };
  }

  // Skew from the response's serverNow (SPEC 7): store for the next stamps.
  const serverNowMs = Date.parse(body.serverNow);
  if (!isNaN(serverNowMs)) {
    const skew = estimateSkew(serverNowMs, tSent, tReceived);
    await setMeta(META_KEYS.SKEW_ESTIMATE_MS, skew);
  }
  await setLastSyncAt(now());

  let synced = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const result = body.items[i];
    if (!result) {
      // Envelope mismatch: treat like a network blip, not a rejection.
      await _handleNetworkError([item], 'no_response_item', now);
      failed++;
      continue;
    }
    if (result.status === 'created' || result.status === 'duplicate') {
      await markSynced(item.id, result.warnings ?? null);
      synced++;
    } else {
      await markFailed(item.id, result.reason ?? 'rejected');
      failed++;
    }
  }

  _globalAttempts = 0;
  _loginRequired = false;
  return { kind: 'synced', sent: synced, failed, serverNow: body.serverNow };
}

async function _handleNetworkError(
  items: { id: string; attempts: number }[],
  errorKind: string,
  now: () => number
): Promise<void> {
  _globalAttempts++;
  const delayMs = _jitter(_backoffDelay());
  const notBefore = now() + delayMs;
  await Promise.all(items.map((item) => setBackoff(item.id, notBefore, item.attempts + 1, errorKind)));
}

/** Reset the backoff multiplier — called on online/foreground events. */
export function resetBackoff(): void {
  _globalAttempts = 0;
}
