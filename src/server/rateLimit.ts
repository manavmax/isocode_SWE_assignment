/**
 * Login rate limit: per username + client IP, in-memory, before any password
 * work. Parameters are A30: 5 failed attempts per 15-minute window, the key
 * freezes out until the window passes. Intentionally per-instance (the demo
 * runs on a single serverless instance); see A30 for the documented limit of
 * that. Clock is always a parameter so the rules stay testable without a live
 * DB and without real sleeps.
 */
export interface LoginThrottle {
  blocked: boolean;
  /** Milliseconds until the block lifts (0 when not blocked). */
  retryAfterMs: number;
  failures: number;
}

interface Window {
  /** Oldest surviving failure timestamp in the window. */
  windowStart: number;
  count: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

const failures = new Map<string, Window>();

export function checkLoginThrottle(key: string, now: number): LoginThrottle {
  const w = failures.get(key);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    return { blocked: false, retryAfterMs: 0, failures: 0 };
  }
  return {
    blocked: w.count >= MAX_FAILURES_PER_WINDOW,
    retryAfterMs: w.count >= MAX_FAILURES_PER_WINDOW ? Math.ceil(w.windowStart + WINDOW_MS - now) : 0,
    failures: w.count
  };
}

export function recordLoginFailure(key: string, now: number): void {
  if (failures.size >= 1024) {
    sweep(now);
  }
  const w = failures.get(key);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    failures.set(key, { windowStart: now, count: 1 });
  } else {
    w.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

function sweep(now: number): void {
  for (const [key, w] of failures) {
    if (now - w.windowStart >= WINDOW_MS) {
      failures.delete(key);
    }
  }
}

/** Test-only: the in-memory store is shared across test cases in one process. */
export function resetLoginThrottleForTests(): void {
  failures.clear();
}
