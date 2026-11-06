import { describe, expect, it } from 'vitest';
import {
  LOGIN_WINDOW_MS,
  loginThrottleKey,
  MAX_FAILURES_PER_WINDOW,
  throttleDecision,
  windowDecision,
  type AttemptRow
} from './rateLimit.js';

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

/**
 * The generic fixed-window counter (reveal limiter, A56): same login-attempt
 * table, same upsert shape, parameterised window and cap. 30 reveals per
 * officer per hour is the reveal policy.
 */
const REVEAL_WINDOW_MS = 60 * 60_000;
const REVEAL_MAX_PER_WINDOW = 30;

describe('windowDecision — shared fixed-window math (reveal: 30/hour per officer)', () => {
  it('is open with no row or an expired row and reports count 0', () => {
    expect(windowDecision(null, T0, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW)).toEqual({
      blocked: false,
      retryAfterMs: 0,
      count: 0
    });
    const expired = attemptRow(REVEAL_MAX_PER_WINDOW, T0 - REVEAL_WINDOW_MS);
    expect(windowDecision(expired, T0, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW).blocked).toBe(false);
  });

  it('stays open at -1 and blocks exactly at the cap inside the window', () => {
    expect(windowDecision(attemptRow(29, T0), T0, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW).blocked).toBe(false);
    expect(windowDecision(attemptRow(30, T0), T0, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW).blocked).toBe(true);
  });

  it('re-opens the instant the hour lapses and answers a usable Retry-After while blocked', () => {
    const blocked = attemptRow(30, T0);
    expect(windowDecision(blocked, T0 + REVEAL_WINDOW_MS, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW).blocked).toBe(false);
    const nearClose = windowDecision(blocked, T0 + 1000, REVEAL_WINDOW_MS, REVEAL_MAX_PER_WINDOW);
    expect(nearClose.retryAfterMs).toBeGreaterThan(0);
    expect(nearClose.retryAfterMs).toBeLessThanOrEqual(REVEAL_WINDOW_MS);
  });

  it('the login decision is the generic one with its own policy numbers', () => {
    expect(throttleDecision(attemptRow(5, T0), T0).blocked).toBe(
      windowDecision(attemptRow(5, T0), T0, LOGIN_WINDOW_MS, MAX_FAILURES_PER_WINDOW).blocked
    );
  });
});
