import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptDateIst,
  classifyCallSpan,
  CONTACT_WINDOW_END_MIN,
  CONTACT_WINDOW_START_MIN,
  decideAttemptWindow,
  isWithinContactWindow,
  ruleSetFor
} from './contactWindow.js';
import { CONTACT_RULE_SETS, RBC2025_PARA100_ID, RECOVERY2026_100Y_ID, RECOVERY_SWITCH_DATE_IST } from './ruleSets.js';

/** Build the UTC instant whose IST clock reads `time` on the IST date `date`.
 * The device timezone never enters: everything parses from Z-suffixed strings. */
function ist(date: string, time: string): number {
  return Date.parse(`${date}T${time}Z`) - 330 * 60_000;
}

afterEach(() => {
  process.env.TZ = undefined;
});

describe('isWithinContactWindow — the four boundaries (SPEC 7)', () => {
  it('07:59:59 IST is outside the window', () => {
    expect(isWithinContactWindow(ist('2026-11-06', '07:59:59'))).toBe(false);
  });

  it('08:00:00 IST is inside (window opens inclusive)', () => {
    expect(isWithinContactWindow(ist('2026-11-06', '08:00:00'))).toBe(true);
  });

  it('18:59:59 IST is inside (end is exclusive)', () => {
    expect(isWithinContactWindow(ist('2026-11-06', '18:59:59'))).toBe(true);
  });

  it('19:00:00 IST is outside (minute 1140 is excluded)', () => {
    expect(isWithinContactWindow(ist('2026-11-06', '19:00:00'))).toBe(false);
  });
});

describe('isWithinContactWindow — UTC instants that fall on a different IST date', () => {
  it('18:30:01Z on Dec 31 (UTC) is 00:00:01 IST on Jan 1 and is outside', () => {
    const utcMs = Date.parse('2026-12-31T18:30:01Z');
    expect(istMinutesFormula(utcMs)).toBe(0); // sanity: exactly one IST minute past midnight
    expect(isWithinContactWindow(utcMs)).toBe(false);
    expect(attemptDateIst(utcMs)).toBe('2027-01-01'); // IST date differs from the UTC date
  });

  it('19:45:00Z on Jun 15 (UTC) is 01:15 IST on Jun 16 and is outside', () => {
    const utcMs = Date.parse('2026-06-15T19:45:00Z');
    expect(isWithinContactWindow(utcMs)).toBe(false);
    expect(attemptDateIst(utcMs)).toBe('2026-06-16');
  });
});

describe('isWithinContactWindow — independent of the device timezone', () => {
  it('identical results with the process clock set to New York', () => {
    process.env.TZ = 'America/New_York';
    // 12:30Z = 18:00 IST, inside the window. The same instant read through a
    // naive local-getters implementation would read 07:30 in New York.
    expect(isWithinContactWindow(Date.parse('2026-11-06T12:30:00Z'))).toBe(true);
    // 14:30Z -> 20:00 IST, outside: the verdict must not flip with the device zone.
    expect(isWithinContactWindow(Date.parse('2026-11-06T14:30:00Z'))).toBe(false);
  });

  it('a Kiritimati (UTC+14) device agrees: the formula only ever sees utcMs', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    expect(isWithinContactWindow(ist('2026-11-06', '09:59:59'))).toBe(true);
    expect(isWithinContactWindow(ist('2026-11-06', '18:00:00'))).toBe(true);
    expect(isWithinContactWindow(ist('2026-11-06', '07:30:00'))).toBe(false);
  });
});

describe('ruleSetFor — the 2027-01-01 switch (SPEC 20.2)', () => {
  it('dates before 2027-01-01 select RBC2025_para100', () => {
    expect(ruleSetFor('2026-12-31').id).toBe(RBC2025_PARA100_ID);
  });

  it('2027-01-01 itself selects RECOVERY2026_100Y', () => {
    expect(ruleSetFor(RECOVERY_SWITCH_DATE_IST).id).toBe(RECOVERY2026_100Y_ID);
  });

  it('the rule set of an attempt is chosen by its IST date, not the UTC date', () => {
    const justAfterMidnightIst = Date.parse('2026-12-31T18:30:01Z'); // 2027-01-01 00:00:01 IST
    expect(ruleSetFor(attemptDateIst(justAfterMidnightIst)).id).toBe(RECOVERY2026_100Y_ID);
  });
});

describe('borrower_requested_time exception — RECOVERY2026_100Y only, evidence required', () => {
  const OUTSIDE_UTC_MS = ist('2027-03-27', '20:15:00'); // after 19:00, under the 2027 rule set

  it('grants the exception when both the borrower-requested flag and evidence are present', () => {
    const decision = decideAttemptWindow(OUTSIDE_UTC_MS, {
      borrowerRequestedTime: true,
      evidence: 'borrower called at 20:05 and asked us to call back now'
    });
    expect(decision.withinWindow).toBe(true);
    expect(decision.exceptionApplied).toBe(true);
    expect(decision.ruleSetId).toBe(RECOVERY2026_100Y_ID);
    expect(decision.windowOnly).toBe(false);
  });

  it('refuses the evidence without the borrower-requested flag', () => {
    const decision = decideAttemptWindow(OUTSIDE_UTC_MS, {
      borrowerRequestedTime: false,
      evidence: 'borrower asked for an evening call'
    });
    expect(decision.withinWindow).toBe(false);
    expect(decision.exceptionApplied).toBe(false);
  });

  it('refuses the flag without evidence — whitespace does not count', () => {
    expect(decideAttemptWindow(OUTSIDE_UTC_MS, { borrowerRequestedTime: true }).exceptionApplied).toBe(false);
    expect(
      decideAttemptWindow(OUTSIDE_UTC_MS, { borrowerRequestedTime: true, evidence: '   ' }).exceptionApplied
    ).toBe(false);
    expect(
      decideAttemptWindow(OUTSIDE_UTC_MS, { borrowerRequestedTime: true, evidence: null }).exceptionApplied
    ).toBe(false);
  });

  it('is unavailable under RBC2025_para100 (the 2025 circular has no such clause)', () => {
    const decision = decideAttemptWindow(ist('2026-11-06', '20:15:00'), {
      borrowerRequestedTime: true,
      evidence: 'borrower asked us to call back tonight'
    });
    expect(decision.withinWindow).toBe(false);
    expect(decision.exceptionApplied).toBe(false);
    expect(decision.ruleSetId).toBe(RBC2025_PARA100_ID);
  });

  it('an attempt inside the window never invokes the exception', () => {
    const decision = decideAttemptWindow(ist('2027-03-27', '10:00:00'), {
      borrowerRequestedTime: true,
      evidence: 'irrelevant'
    });
    expect(decision.withinWindow).toBe(true);
    expect(decision.exceptionApplied).toBe(false);
    expect(decision.windowOnly).toBe(true);
  });
});

describe('classifyCallSpan — a call that ran past 19:00 is a warning, not a violation', () => {
  it('18:59 start ending 19:03 IST is the warning case (started inside, bled past the end)', () => {
    expect(classifyCallSpan(ist('2026-11-06', '18:59:00'), ist('2026-11-06', '19:03:00'))).toBe(
      'ran_past_end_warning'
    );
  });

  it('18:59:30 to 19:00:30 IST warns even for a 60-second overrun', () => {
    expect(classifyCallSpan(ist('2026-11-06', '18:59:30'), ist('2026-11-06', '19:00:30'))).toBe(
      'ran_past_end_warning'
    );
  });

  it('08:00 to 08:05 IST is fully inside the window', () => {
    expect(classifyCallSpan(ist('2026-11-06', '08:00:00'), ist('2026-11-06', '08:05:00'))).toBe(
      'inside_window'
    );
  });

  it('18:30 to 18:55 IST stays well inside the window', () => {
    expect(classifyCallSpan(ist('2026-11-06', '18:30:00'), ist('2026-11-06', '18:55:00'))).toBe(
      'inside_window'
    );
  });

  it('a call started outside the window classifies as started-outside, never a warning', () => {
    expect(
      classifyCallSpan(ist('2026-11-06', '07:59:59'), ist('2026-11-06', '08:02:00'))
    ).toBe('started_outside');
    expect(
      classifyCallSpan(ist('2026-11-06', '19:05:00'), ist('2026-11-06', '19:20:00'))
    ).toBe('started_outside');
  });
});

describe('shared window constants stay pinned to the SPEC 7 formula', () => {
  it('both rule sets enforce 08:00 (480) to 19:00 (1140) so the formula is authoritative', () => {
    expect(CONTACT_WINDOW_START_MIN).toBe(480);
    expect(CONTACT_WINDOW_END_MIN).toBe(1140);
    for (const ruleSet of Object.values(CONTACT_RULE_SETS)) {
      expect(ruleSet.startMinuteIst).toBe(CONTACT_WINDOW_START_MIN);
      expect(ruleSet.endMinuteIst).toBe(CONTACT_WINDOW_END_MIN);
    }
  });
});

/** The SPEC formula restated by hand (guards against drift in shared math). */
function istMinutesFormula(utcMs: number): number {
  return (Math.floor(utcMs / 60_000) + 330) % 1440;
}
