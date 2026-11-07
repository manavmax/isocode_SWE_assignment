import type { ApiError } from '../api.js';
import { t, type Lang } from '../i18n/dictionary.js';

/** How the login screen may describe a failed sign-in. ONLY a 401 from
 * /api/auth/login may say the credentials were wrong: a 404 or 5xx (or a
 * fetch that never completed) means the server was not reachable at all —
 * including Vercel answering before our app — and must never read as
 * "wrong username or PIN". */
export type LoginErrorKind = 'invalid' | 'throttled' | 'unreachable';

export function loginErrorKind(error: ApiError): LoginErrorKind {
  if (error.kind === 'unauthorized') return 'invalid';
  if (error.kind === 'throttled') return 'throttled';
  return 'unreachable';
}

/** Human wait time for the rate-limit message: seconds under a minute,
 * whole minutes otherwise (the server always sends whole seconds). */
export function formatRetryWait(seconds: number, lang: Lang): string {
  const wholeSeconds = Math.max(1, Math.ceil(seconds));
  if (wholeSeconds < 60) {
    return lang === 'hi' ? `${wholeSeconds} सेकंड` : `${wholeSeconds}s`;
  }
  const minutes = Math.ceil(wholeSeconds / 60);
  return lang === 'hi' ? `${minutes} मिनट` : `${minutes} min`;
}

export function loginErrorMessage(kind: LoginErrorKind, lang: Lang, retryAfterSeconds?: number): string {
  if (kind === 'invalid') return t(lang, 'loginInvalid');
  if (kind === 'throttled') {
    return retryAfterSeconds === undefined
      ? t(lang, 'loginThrottledPlain')
      : t(lang, 'loginThrottled', { wait: formatRetryWait(retryAfterSeconds, lang) });
  }
  return t(lang, 'loginUnreachable');
}
