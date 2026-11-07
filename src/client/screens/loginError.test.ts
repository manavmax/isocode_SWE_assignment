import { describe, expect, it } from 'vitest';
import type { ApiError } from '../api.js';
import { formatRetryWait, loginErrorMessage, loginErrorKind } from './loginError.js';

/**
 * The login screen's ONLY allowed readings of a failed sign-in: 401 says the
 * credentials were wrong, 429 says rate-limited (with the server's wait
 * time), and everything else — fetch failure, 404 (e.g. the Vercel routing
 * bug that shipped), 5xx — is "can't reach the server". These strings are
 * what the screen renders, in both languages.
 */
function apiError(kind: ApiError['kind'], status: number, extra: Partial<ApiError> = {}): ApiError {
  return { kind, status, ...extra };
}

describe('loginErrorKind', () => {
  it('only a 401 maps to the wrong-credentials message', () => {
    expect(loginErrorKind(apiError('unauthorized', 401))).toBe('invalid');
  });

  it('a 429 maps to the rate-limit message', () => {
    expect(loginErrorKind(apiError('throttled', 429, { retryAfterSeconds: 90 }))).toBe('throttled');
  });

  it('a network failure, a 404 and a 5xx all map to the unreachable message', () => {
    expect(loginErrorKind(apiError('network', 0))).toBe('unreachable');
    expect(loginErrorKind(apiError('notFound', 404))).toBe('unreachable');
    expect(loginErrorKind(apiError('server', 500))).toBe('unreachable');
    expect(loginErrorKind(apiError('server', 503))).toBe('unreachable');
  });
});

describe('loginErrorMessage', () => {
  it('401 shows wrong username or PIN in both languages', () => {
    expect(loginErrorMessage('invalid', 'en')).toBe('Wrong username or PIN');
    expect(loginErrorMessage('invalid', 'hi')).toBe('यूज़रनेम या पिन गलत है');
  });

  it('429 shows the rate-limit message with the wait time in both languages', () => {
    expect(loginErrorMessage('throttled', 'en', 45)).toBe('Too many attempts. Try again in 45s.');
    expect(loginErrorMessage('throttled', 'hi', 45)).toBe('बहुत अधिक कोशिशें हो गईं। 45 सेकंड बाद फिर कोशिश करें।');
    expect(loginErrorMessage('throttled', 'en', 120)).toBe('Too many attempts. Try again in 2 min.');
    expect(loginErrorMessage('throttled', 'hi', 120)).toBe('बहुत अधिक कोशिशें हो गईं। 2 मिनट बाद फिर कोशिश करें।');
  });

  it('429 without a parseable Retry-After falls back to the plain wait message', () => {
    expect(loginErrorMessage('throttled', 'en', undefined)).toBe('Too many attempts. Try again in a few minutes.');
    expect(loginErrorMessage('throttled', 'hi', undefined)).toBe('बहुत अधिक कोशिशें हो गईं। कुछ मिनट बाद फिर कोशिश करें।');
  });

  it('network failure, 404 and 5xx show the distinct unreachable message, never the credential one', () => {
    const kinds: Array<Parameters<typeof loginErrorMessage>[0]> = ['unreachable', 'unreachable', 'unreachable'];
    for (const kind of kinds) {
      expect(loginErrorMessage(kind, 'en')).toBe("Can't reach the server. Try again.");
      expect(loginErrorMessage(kind, 'hi')).toBe('सर्वर से संपर्क नहीं हो पाया। फिर कोशिश करें।');
    }
    const unreachable = loginErrorMessage('unreachable', 'en');
    expect(unreachable).not.toBe(loginErrorMessage('invalid', 'en'));
    expect(unreachable).not.toContain('username');
    expect(unreachable).not.toContain('PIN');
  });
});

describe('formatRetryWait', () => {
  it('formats seconds under a minute and minutes above it', () => {
    expect(formatRetryWait(1, 'en')).toBe('1s');
    expect(formatRetryWait(59, 'en')).toBe('59s');
    expect(formatRetryWait(60, 'en')).toBe('1 min');
    expect(formatRetryWait(897, 'en')).toBe('15 min');
    expect(formatRetryWait(59, 'hi')).toBe('59 सेकंड');
    expect(formatRetryWait(897, 'hi')).toBe('15 मिनट');
  });
});
