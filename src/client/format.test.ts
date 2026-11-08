import { describe, expect, it } from 'vitest';
import { formatDateShort, formatDayMonth, formatMoneyExact, formatMoneyShort, pluralCopy, promiseDueChip } from './format.js';

/**
 * The one formatter module (prompt 20 item 10): money short/exact, IST
 * date labels with an injected clock, plural-aware copy in en and hi.
 */

describe('formatMoneyShort (lists and tiles)', () => {
  it('renders the lakh short form with 3 significant digits', () => {
    // 1235652.35 rupees → 12.3565 L → "₹12.4 L"
    expect(formatMoneyShort(123565235)).toBe('₹12.4 L');
    expect(formatMoneyShort(2060000000)).toBe('₹2.06 Cr');
  });

  it('trims trailing zeros — never ".00"', () => {
    expect(formatMoneyShort(10000000)).toBe('₹1 L'); // exactly 1 lakh
    expect(formatMoneyShort(2000000000)).toBe('₹2 Cr'); // exactly 2 crore
    expect(formatMoneyShort(2050000000)).toBe('₹2.05 Cr');
    expect(formatMoneyShort(100000000)).toBe('₹10 L');
  });

  it('keeps integer zeros intact below one lakh (grouped rupees)', () => {
    expect(formatMoneyShort(8500000)).toBe('₹85,000');
    expect(formatMoneyShort(9990000)).toBe('₹99,900');
    expect(formatMoneyShort(123400)).toBe('₹1,234');
    expect(formatMoneyShort(500)).toBe('₹5');
  });

  it('keeps the sign for negative amounts', () => {
    expect(formatMoneyShort(-123565235)).toBe('-₹12.4 L');
  });

  it('renders non-finite as an em dash', () => {
    expect(formatMoneyShort(Number.NaN)).toBe('—');
  });
});

describe('formatMoneyExact (loan-detail facts)', () => {
  it('renders exact Indian-grouped rupees without paise when whole', () => {
    expect(formatMoneyExact(123564300)).toBe('₹12,35,643');
  });

  it('appends paise only when non-zero', () => {
    expect(formatMoneyExact(123564345)).toBe('₹12,35,643.45');
    expect(formatMoneyExact(100000)).toBe('₹1,000');
  });
});

describe('formatDateShort (IST day, clock injected)', () => {
  // 2026-11-09T06:30:00Z == 12:00 IST on 2026-11-09
  const noonIst = Date.parse('2026-11-09T06:30:00Z');

  it('returns Today only when the date equals the IST day of now', () => {
    expect(formatDateShort('2026-11-09', noonIst, 'en')).toBe('Today');
    expect(formatDateShort('2026-11-09', noonIst, 'hi')).toBe('आज');
  });

  it('returns Tomorrow for the next IST day', () => {
    expect(formatDateShort('2026-11-10', noonIst, 'en')).toBe('Tomorrow');
    expect(formatDateShort('2026-11-10', noonIst, 'hi')).toBe('कल');
  });

  it('renders other days as "9 Nov" (never ISO)', () => {
    expect(formatDateShort('2026-11-12', noonIst, 'en')).toBe('12 Nov');
    expect(formatDateShort('2026-11-12', noonIst, 'hi')).toBe('12 नव');
  });

  it('the IST day boundary decides: 23:30 IST is still the same day', () => {
    const lateIst = Date.parse('2026-11-09T18:00:00Z'); // 23:30 IST
    expect(formatDateShort('2026-11-09', lateIst, 'en')).toBe('Today');
    expect(formatDateShort('2026-11-10', lateIst, 'en')).toBe('Tomorrow');
  });

  it('an unknown key renders as-is (defensive, never crashes)', () => {
    expect(formatDateShort('', noonIst, 'en')).toBe('');
  });
});

describe('formatDayMonth', () => {
  it('maps month numbers to short names in both languages', () => {
    expect(formatDayMonth('2026-01-05', 'en')).toBe('5 Jan');
    expect(formatDayMonth('2026-01-05', 'hi')).toBe('5 जन');
    expect(formatDayMonth('2026-12-31', 'en')).toBe('31 Dec');
  });

  it('returns the input unchanged when it is not a date key', () => {
    expect(formatDayMonth('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('pluralCopy (en + hi)', () => {
  it('picks the singular form for 1', () => {
    expect(pluralCopy('en', { one: 'promisesDueTodayOne', other: 'promisesDueToday' }, 1)).toBe('1 promise due');
    expect(pluralCopy('hi', { one: 'promisesDueTodayOne', other: 'promisesDueToday' }, 1)).toBe('1 वादा आज देना है');
  });

  it('picks the plural form for 0, 2 and 12', () => {
    expect(pluralCopy('en', { one: 'promisesDueTodayOne', other: 'promisesDueToday' }, 0)).toBe('0 promises due');
    expect(pluralCopy('en', { one: 'promisesDueTodayOne', other: 'promisesDueToday' }, 2)).toBe('2 promises due');
    expect(pluralCopy('hi', { one: 'promisesDueTodayOne', other: 'promisesDueToday' }, 12)).toBe('12 वादे आज देने हैं');
  });

  it('renders role names translated', () => {
    expect(pluralCopy('en', { one: 'roleFieldOfficer', other: 'roleBranchManager' }, 1)).toBe('Field officer');
    expect(pluralCopy('hi', { one: 'roleFieldOfficer', other: 'roleBranchManager' }, 2)).toBe('ब्रांच मैनेजर');
  });
});

describe('promiseDueChip (prompt 20 item 2)', () => {
  const noonIst = Date.parse('2026-11-09T06:30:00Z');

  it('says "Due today" ONLY when the promised date equals today (IST)', () => {
    expect(promiseDueChip('2026-11-09', noonIst, 'en')).toBe('Due today');
    expect(promiseDueChip('2026-11-09', noonIst, 'hi')).toBe('आज देना है');
  });

  it('says "Tomorrow" for the next day — never "Due today"', () => {
    expect(promiseDueChip('2026-11-10', noonIst, 'en')).toBe('Tomorrow');
    expect(promiseDueChip('2026-11-10', noonIst, 'hi')).toBe('कल');
  });

  it('says the concrete date for any other day', () => {
    expect(promiseDueChip('2026-11-12', noonIst, 'en')).toBe('12 Nov');
    expect(promiseDueChip('2026-11-12', noonIst, 'hi')).toBe('12 नव');
  });

  it('a past date shows the concrete date, never "Due today"', () => {
    expect(promiseDueChip('2026-11-05', noonIst, 'en')).toBe('5 Nov');
  });
});
