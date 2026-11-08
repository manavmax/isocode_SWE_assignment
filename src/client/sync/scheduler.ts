/**
 * Sync scheduler (SPEC 6 triggers): wires engine flush() to app events.
 * Triggers: app start, online, visibility change, after each save, every
 * 30-60 s while visible with pending items, manual Sync now.
 * Does NOT gate on navigator.onLine — offline flush attempts are normal
 * and produce a network error for backoff.
 */
import { flush, resetBackoff } from './engine.js';
import { getOutboxCounts } from '../dexie/db.js';

const INTERVAL_MS = 45_000; // mid-point of 30-60 s spec

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _kickTimeout: ReturnType<typeof setTimeout> | null = null;
const KICK_DELAY_MS = 5_250; // 5 s undo hold + 250 ms slack

export function startSyncScheduler(): () => void {
  const onOnline = () => {
    resetBackoff();
    void flush().catch((err) => console.error('[sync] scheduler flush failed:', String(err).slice(0, 300)));
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      resetBackoff();
      void flush().catch((err) => console.error('[sync] scheduler flush failed:', String(err).slice(0, 300)));
    }
  };

  const onInterval = async () => {
    if (document.visibilityState !== 'visible') return;
    const counts = await getOutboxCounts();
    if (counts.pending > 0) {
      await flush();
    }
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('visibilitychange', onVisibilityChange);
  _intervalId = setInterval(onInterval, INTERVAL_MS);

  // App start is a flush trigger too (SPEC 6.3): anything queued since the
  // last session goes out as soon as the shell is up. Honours not_before, so
  // 5 s undo holds are never violated by this first attempt.
  void flush().catch((err) => console.error('[sync] scheduler flush failed:', String(err).slice(0, 300)));

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('visibilitychange', onVisibilityChange);
    if (_intervalId !== null) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
    if (_kickTimeout !== null) {
      clearTimeout(_kickTimeout);
      _kickTimeout = null;
    }
  };
}

/** Trigger a flush shortly — used after each save. Honours the 5 s undo
 * hold via not_before in the DB; the engine's next flush will pick up items
 * whose not_before has passed. */
export function kick(): void {
  if (_kickTimeout !== null) return; // already scheduled
  _kickTimeout = setTimeout(() => {
    _kickTimeout = null;
    void flush().catch((err) => console.error('[sync] kick flush failed:', String(err).slice(0, 300)));
  }, KICK_DELAY_MS);
}

/** Manual Sync now — ignores pending kick, forces immediate flush. */
export async function syncNow(): Promise<void> {
  if (_kickTimeout !== null) {
    clearTimeout(_kickTimeout);
    _kickTimeout = null;
  }
  try {
    await flush();
  } catch (err) {
    console.error('[sync] syncNow flush failed:', String(err).slice(0, 300));
  }
}
