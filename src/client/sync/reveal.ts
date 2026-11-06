/**
 * Phone reveal: cache-first (end of IST day), online fetch fallback.
 * The reveal endpoint requires in-window check on server time.
 * Offline with no cache → clear offline message (bilingual key provided).
 */
import { api } from '../api.js';
import { getCachedReveal, setCachedReveal } from '../dexie/db.js';

export interface RevealResult {
  phone: string | null;
  altPhone: string | null;
  offline?: boolean;
  error?: string;
}

export async function getBorrowerPhone(loanId: string): Promise<RevealResult> {
  const cached = await getCachedReveal(loanId);
  if (cached) {
    return { phone: cached.phone, altPhone: cached.altPhone };
  }
  const res = await api.revealPhone(loanId);
  if (!res.ok) {
    if (res.error.kind === 'network') {
      return { phone: null, altPhone: null, offline: true };
    }
    if (res.error.kind === 'forbidden') {
      return { phone: null, altPhone: null, error: 'outside_window' };
    }
    return { phone: null, altPhone: null, error: 'server_error' };
  }
  const { mobile, altMobile } = res.data;
  await setCachedReveal(loanId, mobile, altMobile);
  return { phone: mobile, altPhone: altMobile };
}
