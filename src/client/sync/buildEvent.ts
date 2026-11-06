/**
 * Build a ContactEventInput for the outbox. Pure function of its inputs;
 * async only for the skew lookup (injected for tests).
 */
import type { ContactEventInput } from '../../shared/sync/eventSchema.js';
import { getSkew } from '../dexie/db.js';
import { buildGpsFields } from '../gps.js';
import type { GpsState } from '../gps.js';
import { validatePromiseCreation } from '../../shared/promises.js';

export interface BuildEventOptions {
  loanId: string;
  kind: 'CALL' | 'VISIT' | 'MESSAGE' | 'BLOCKED';
  outcome: string;
  promisedDate?: string;
  promisedAmount?: number;
  note?: string | null;
  gps: GpsState;
  attemptedAtMs?: number;
  skewMs?: number;
  tzOffsetMin?: number;
}

export function buildEventSync(opts: BuildEventOptions): Omit<ContactEventInput, 'skew_estimate_ms'> {
  const nowMs = opts.attemptedAtMs ?? Date.now();
  return {
    id: crypto.randomUUID(),
    loan_id: opts.loanId,
    kind: opts.kind,
    outcome: opts.outcome as ContactEventInput['outcome'],
    attempted_at_device: new Date(nowMs).toISOString(),
    device_tz_offset_min: opts.tzOffsetMin ?? -new Date().getTimezoneOffset(),
    ...buildGpsFields(opts.gps),
    note: opts.note ?? null,
    promised_date: opts.promisedDate ?? null,
    promised_amount: opts.promisedAmount ?? null
  };
}

export async function buildContactEvent(opts: BuildEventOptions): Promise<ContactEventInput> {
  const skew = opts.skewMs ?? (await getSkew());
  return {
    ...buildEventSync(opts),
    skew_estimate_ms: skew
  };
}

export function validatePromiseClient(
  promisedDate: string,
  promisedAmount: number,
  todayIstKey: string,
  bucket: string,
  overduePaise: number,
  outstandingPaise: number
): { ok: boolean; error?: string } {
  const result = validatePromiseCreation(
    { promised_date: promisedDate, promised_amount: promisedAmount },
    {
      todayIst: todayIstKey,
      bucket,
      overduePaise,
      outstandingPaise,
      openPromiseId: null,
      rescheduleCount: 0
    }
  );
  if (result.ok) return { ok: true };
  return { ok: false, error: result.reasons[0] };
}
