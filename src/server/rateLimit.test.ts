import { afterEach, describe, expect, it } from 'vitest';
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure, resetLoginThrottleForTests } from './rateLimit.js';

const T0 = 5_000_000; // a fixed epoch ms

describe('login rate limit (per username + IP, A30: 5 failures per 15 minutes)', () => {
  afterEach(() => {
    resetLoginThrottleForTests();
  });

  it('records failures and blocks the key after the 5th within the window', () => {
    for (let i = 0; i < 4; i++) {
      recordLoginFailure('user|1.1.1.1', T0 + i);
      expect(checkLoginThrottle('user|1.1.1.1', T0 + i).blocked).toBe(false);
    }
    recordLoginFailure('user|1.1.1.1', T0 + 4);
    const after = checkLoginThrottle('user|1.1.1.1', T0 + 4);
    expect(after.blocked).toBe(true);
    expect(after.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts attempts per username+IP: a different IP is its own key', () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure('user|1.1.1.1', T0 + i);
    }
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 5).blocked).toBe(true);
    expect(checkLoginThrottle('user|2.2.2.2', T0 + 5).blocked).toBe(false);
    expect(checkLoginThrottle('other-user|1.1.1.1', T0 + 5).blocked).toBe(false);
  });

  it('lifts the block once the 15-minute window has passed and starts fresh', () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure('user|1.1.1.1', T0);
    }
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 15 * 60_000 - 1).blocked).toBe(true);
    const afterWindow = checkLoginThrottle('user|1.1.1.1', T0 + 15 * 60_000);
    expect(afterWindow.blocked).toBe(false);
    recordLoginFailure('user|1.1.1.1', T0 + 15 * 60_000 + 1);
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 15 * 60_000 + 1).failures).toBe(1);
  });

  it('a successful login clears the recorded failures', () => {
    for (let i = 0; i < 5; i++) {
      recordLoginFailure('user|1.1.1.1', T0 + i);
    }
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 5).blocked).toBe(true);
    clearLoginFailures('user|1.1.1.1');
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 6).blocked).toBe(false);
    expect(checkLoginThrottle('user|1.1.1.1', T0 + 6).failures).toBe(0);
  });
});
