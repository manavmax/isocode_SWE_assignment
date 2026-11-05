import { describe, expect, it } from 'vitest';
import { LOGIN_WINDOW_MS, loginThrottleKey, MAX_FAILURES_PER_WINDOW, throttleDecision, type AttemptRow } from './rateLimit.js';

const T0 = 5_000_000; // a fixed epoch ms

function attemptRow(failCount: number, windowStartMs: number): AttemptRow {
  return { failCount, windowStart: new Date(windowStartMs) };
}

describe('loginThrottleKey (A30: username + client IP)', () => {
  it('keeps each username and each client IP in its own window', () => {
    expect(loginThrottleKey('user', '1.1.1.1')).toBe('user|1.1.1.1');
    expect(loginThrottleKey('user', '1.1.1.1')).not.toBe(loginThrottleKey('user', '2.2.2.2'));
    expect(loginThrottleKey('user', '1.1.1.1')).not.toBe(loginThrottleKey('other-user', '1.1.1.1'));
  });
});

describe('throttleDecision (window math; the counter lives in the login_attempt table)', () => {
  it('is open with no recorded row and below the failure threshold', () => {
    expect(throttleDecision(null, T0)).toEqual({ blocked: false, retryAfterMs: 0, failures: 0 });
    expect(throttleDecision(attemptRow(1, T0), T0).blocked).toBe(false);
    expect(throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW - 1, T0), T0).blocked).toBe(false);
  });

  it('blocks at MAX_FAILURES_PER_WINDOW inside the window and answers a positive Retry-After', () => {
    const decision = throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW, T0 + 5), T0 + 5);
    expect(decision.blocked).toBe(true);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.failures).toBe(MAX_FAILURES_PER_WINDOW);
  });

  it('stays closed only until the 15-minute window passes', () => {
    expect(throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW, T0), T0 + LOGIN_WINDOW_MS - 1).blocked).toBe(true);
    const after = throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW, T0), T0 + LOGIN_WINDOW_MS);
    expect(after.blocked).toBe(false);
    expect(after.failures).toBe(0);
  });

  it('Retry-After decays toward zero as the window ages (no fresh penalty per lookup)', () => {
    const fresh = throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW, T0), T0);
    const aged = throttleDecision(attemptRow(MAX_FAILURES_PER_WINDOW, T0), T0 + LOGIN_WINDOW_MS - 1);
    expect(aged.retryAfterMs).toBeLessThan(fresh.retryAfterMs);
  });
});
