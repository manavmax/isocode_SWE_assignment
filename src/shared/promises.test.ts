import { describe, expect, it } from 'vitest';
import {
  addIstDays,
  DEFAULT_PROMISE_GRACE_DAYS,
  isSundayIst,
  MAX_PROMISE_RESCHEDULES,
  nextWorkingDayIst,
  PROMISE_MAX_LEAD_DAYS_B1,
  PROMISE_MAX_LEAD_DAYS_B2,
  validatePromiseCreation,
  type PromiseCreationContext,
  type PromiseCreationResult
} from './promises.js';

/** All dates are IST keys. Today is fixed: a Friday in IST. */
const TODAY = '2026-11-06';
const OK_BASE: PromiseCreationContext = {
  todayIst: TODAY,
  bucket: '1-30',
  overduePaise: 50_000,
  outstandingPaise: 200_000,
  openPromiseId: null,
  rescheduleCount: 0
};

function validate(
  over: Partial<PromiseCreationContext> = {},
  promised_date = '2026-11-09',
  promised_amount = 50_000
): PromiseCreationResult {
  return validatePromiseCreation({ promised_date, promised_amount }, { ...OK_BASE, ...over });
}

/** Narrow to the failure variant; throws (failing the test) on ok:true. */
function fallback(result: PromiseCreationResult): { reasons: string[]; rollForwardToDateIst: string | null } {
  if (result.ok) {
    throw new Error('expected a rejected promise creation');
  }
  return result;
}

/** Narrow to the success variant. */
function forceOk(result: PromiseCreationResult) {
  if (!result.ok) {
    throw new Error(`expected a valid promise creation, got: ${result.reasons.join(',')}`);
  }
  return result;
}

describe('validatePromiseCreation — the date window (SPEC 12)', () => {
  it('accepts today itself and any date up to +7 days for a B1 loan', () => {
    expect(validate({}, TODAY).ok).toBe(true);
    expect(validate({}, addIstDays(TODAY, PROMISE_MAX_LEAD_DAYS_B1)).ok).toBe(true);
  });

  it('rejects a promised date in the past (before today IST)', () => {
    expect(fallback(validate({}, '2026-11-05')).reasons).toContain('date_before_today');
  });

  it('rejects +8 days for a B1 (1-30) loan', () => {
    expect(fallback(validate({}, addIstDays(TODAY, 8))).reasons).toContain('date_too_far_out');
    expect(validate({}, addIstDays(TODAY, 7)).ok).toBe(true);
  });

  it('a B2 (31-60) loan rides the +10-day window: +8 fine, +11 too far', () => {
    expect(validate({ bucket: '31-60' }, addIstDays(TODAY, 8)).ok).toBe(true);
    expect(validate({ bucket: '31-60' }, addIstDays(TODAY, PROMISE_MAX_LEAD_DAYS_B2)).ok).toBe(true);
    expect(fallback(validate({ bucket: '31-60' }, addIstDays(TODAY, 11))).reasons).toContain('date_too_far_out');
    expect(PROMISE_MAX_LEAD_DAYS_B2).toBe(10);
  });

  it('a malformed promised_date is invalid before any window arithmetic', () => {
    expect(fallback(validate({}, '09-11-2026')).reasons).toContain('invalid_date');
    expect(fallback(validate({}, '2026-02-30')).reasons).toContain('invalid_date');
    expect(fallback(validate({}, '')).reasons).toContain('invalid_date');
  });
});

describe('validatePromiseCreation — Sundays roll forward with a visible note (SPEC 12)', () => {
  it('rejects a promised Sunday but hands back the rolled-forward date', () => {
    expect(isSundayIst('2026-11-08')).toBe(true);
    const failed = fallback(validate({}, '2026-11-08'));
    expect(failed.reasons).toContain('date_is_sunday');
    expect(failed.rollForwardToDateIst).toBe('2026-11-09'); // Monday
  });

  it('nextWorkingDayIst skips exactly one day off a Sunday and never re-rolls weekdays', () => {
    expect(nextWorkingDayIst('2026-11-08')).toBe('2026-11-09');
    expect(nextWorkingDayIst('2026-11-09')).toBe('2026-11-09');
    expect(nextWorkingDayIst('2026-11-13')).toBe('2026-11-13'); // Friday
  });

  it('a Saturday stays allowed (SPEC blocks only Sundays)', () => {
    expect(isSundayIst('2026-11-07')).toBe(false);
    expect(validate({}, '2026-11-07').ok).toBe(true);
  });

  it('the Sunday boundary is IST-anchored: it never depends on the process clock', () => {
    expect(isSundayIst(addIstDays('2026-11-08', 8))).toBe(false); // the Monday after a Sunday
    expect(isSundayIst('2026-11-15')).toBe(true);
  });
});

describe('validatePromiseCreation — amounts (>= 50% overdue, <= outstanding)', () => {
  it('accepts exactly half the overdue paise and rejects one paise below', () => {
    expect(validate({}, '2026-11-09', 25_000).ok).toBe(true);
    expect(fallback(validate({}, '2026-11-09', 24_999)).reasons).toContain('amount_below_half_overdue');
  });

  it('rounded half is enough for odd overdue values', () => {
    expect(validate({ overduePaise: 5001 }, '2026-11-09', 2501).ok).toBe(true);
    expect(fallback(validate({ overduePaise: 5001 }, '2026-11-09', 2500)).reasons).toContain(
      'amount_below_half_overdue'
    );
  });

  it('a zero-overdue loan only needs a positive amount under the outstanding cap', () => {
    expect(validate({ overduePaise: 0 }, '2026-11-09', 1).ok).toBe(true);
    expect(fallback(validate({ overduePaise: 0 }, '2026-11-09', 0)).reasons).toContain('amount_not_positive');
  });

  it('rejects an amount above the outstanding balance', () => {
    expect(fallback(validate({}, '2026-11-09', 200_001)).reasons).toContain('amount_above_outstanding');
    expect(validate({}, '2026-11-09', 200_000).ok).toBe(true);
  });

  it('rejects non-positive and non-integer amounts', () => {
    expect(fallback(validate({}, '2026-11-09', 0)).reasons).toContain('amount_not_positive');
    expect(fallback(validate({}, '2026-11-09', -100)).reasons).toContain('amount_not_positive');
    expect(fallback(validate({}, '2026-11-09', 50.5)).reasons).toContain('amount_not_positive');
  });

  it('collects multiple violations in one pass', () => {
    const failed = fallback(validate({}, '2026-11-05', 9));
    expect(failed.reasons).toEqual(expect.arrayContaining(['date_before_today', 'amount_below_half_overdue']));
  });
});

describe('validatePromiseCreation — one open promise, and the two-reschedule cap', () => {
  it('a loan with no open promise simply creates (nothing superseded)', () => {
    const ok = forceOk(validate({ openPromiseId: null, rescheduleCount: 0 }));
    expect(ok.supersedesPromiseId).toBeNull();
    expect(ok.graceDays).toBe(DEFAULT_PROMISE_GRACE_DAYS);
  });

  it('a new promise while one is open IS the reschedule: the old id comes back to be superseded', () => {
    const ok = forceOk(validate({ openPromiseId: 'promise-old-1', rescheduleCount: 0 }));
    expect(ok.supersedesPromiseId).toBe('promise-old-1');
  });

  it('the first and second reschedules are allowed; the third is not (max 2 per bucket stay)', () => {
    expect(MAX_PROMISE_RESCHEDULES).toBe(2);
    expect(validate({ openPromiseId: 'p1', rescheduleCount: 1 }).ok).toBe(true);
    expect(fallback(validate({ openPromiseId: 'p1', rescheduleCount: 2 })).reasons).toContain(
      'reschedule_limit_reached'
    );
  });

  it('the reschedule cap ignores loans without an open promise (a fresh stay starts fresh)', () => {
    expect(validate({ openPromiseId: null, rescheduleCount: 4 }).ok).toBe(true);
  });

  it('reschedules still honour the date and amount rules', () => {
    expect(fallback(validate({ openPromiseId: 'p1', rescheduleCount: 0 }, addIstDays(TODAY, 8))).reasons).toContain(
      'date_too_far_out'
    );
    expect(
      fallback(validate({ openPromiseId: 'p1', rescheduleCount: 0 }, '2026-11-09', 24_999)).reasons
    ).toContain('amount_below_half_overdue');
  });
});

describe('addIstDays — the window arithmetic is anchored on IST keys', () => {
  it('crosses month ends and stays on the same IST calendar day', () => {
    expect(addIstDays('2026-11-06', 7)).toBe('2026-11-13');
    expect(addIstDays('2026-11-28', 7)).toBe('2026-12-05');
    expect(addIstDays('2026-12-25', 7)).toBe('2027-01-01');
    expect(addIstDays('2026-11-09', 0)).toBe('2026-11-09');
  });

  it('works backwards for the negative steps the callers may need', () => {
    expect(addIstDays('2026-11-06', -1)).toBe('2026-11-05');
  });
});
