import { describe, expect, it } from 'vitest';
import { buildPromiseStory, type SeedLoanRow, type SeedPayment } from './promisesSeed.js';
import { mulberry32 } from './rng.js';
import { loadSeedConfigFile } from './config.js';
import { fileURLToPath } from 'node:url';
import { promiseDeadline } from '../../src/shared/promiseState.js';
import { isSundayIst } from '../../src/shared/promises.js';
import { DEMO_ACCOUNTS } from '../../src/server/demo.js';

/**
 * The seed part 2 generator, driven offline with fixture loans + payments
 * exactly as main.ts feeds it (DB rows + lms_delta payments). The core
 * assertion is the A63 consistency contract: every stored status is the one
 * the nightly recompute derives from the same payments, so the seed's
 * end-of-run "updated must be 0" check can never fail on generated data.
 */

const config = loadSeedConfigFile(fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url))).promises;

const RAHUL = 'officer-rahul';
const NEHA = 'officer-neha';
const OTHER = 'officer-other';

function loan(overrides: Partial<SeedLoanRow> & { loanId: string }): SeedLoanRow {
  return {
    officerId: OTHER,
    borrowerName: `Borrower ${overrides.loanId}`,
    overdueAmount: 100_000,
    outstanding: 400_000,
    bucket: '1-30',
    status: 'overdue',
    ...overrides
  };
}

function fixtureInput(overrides?: {
  loans?: SeedLoanRow[];
  payments?: [string, SeedPayment[]][];
  demoOfficerIds?: string[];
}) {
  // The demo story pins 35 distinct OPEN promises (12 + 15 + 8), so the
  // fixture needs at least that many overdue loans.
  const generated: SeedLoanRow[] = [];
  for (let i = 1; i <= 40; i += 1) {
    generated.push(
      loan({
        loanId: `LN-${i}`,
        officerId: i % 3 === 0 ? OTHER : i % 2 === 0 ? NEHA : RAHUL,
        bucket: i % 5 === 0 ? '31-60' : '1-30',
        overdueAmount: 80_000 + i * 1_000,
        outstanding: 300_000 + i * 2_000
      })
    );
  }
  generated.push(loan({ loanId: 'LN-CL', status: 'cleared', outstanding: 0, overdueAmount: 0, clearedOn: '2026-10-20' }));
  // The 40 kept-history promises need candidates: 45 cleared loans cover it
  // (a cleared loan is the textbook kept promise, always derivable).
  for (let i = 1; i <= 45; i += 1) {
    generated.push(
      loan({
        loanId: `LN-CL-${i}`,
        status: 'cleared',
        overdueAmount: 60_000 + i * 500,
        outstanding: 0,
        clearedOn: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`
      })
    );
  }
  const loans = overrides?.loans ?? generated;
  const payments = overrides?.payments ?? [
    // LN-3 paid 300k across two drops (supports kept promises of <= ~315k).
    ['LN-3', [{ dateKey: '2026-09-20', amountPaise: 150_000 }, { dateKey: '2026-10-05', amountPaise: 150_000 }]],
    // LN-6 partially paid: supports kept up to ~95k, nothing more.
    ['LN-6', [{ dateKey: '2026-10-10', amountPaise: 100_000 }]],
    // LN-CL (cleared) paid in full on its clearance day.
    ['LN-CL', [{ dateKey: '2026-10-20', amountPaise: 400_000 }]],
    ...Array.from({ length: 45 }, (_, i): [string, SeedPayment[]] => [
      `LN-CL-${i + 1}`,
      [{ dateKey: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`, amountPaise: 200_000 }]
    ])
  ] as [string, SeedPayment[]][];
  const paymentsByLoan = new Map<string, SeedPayment[]>(payments);
  return {
    loans,
    paymentsByLoan,
    windowStart: '2026-08-10',
    asOf: '2026-11-07',
    rng: mulberry32(20261105),
    config,
    demoOfficerIds: overrides?.demoOfficerIds ?? [RAHUL, NEHA]
  };
}

describe('seed part 2 generator (SPEC 12 + 14, prompt 11 item 4)', () => {
  it('hits the demo story counts exactly and derives every status consistently', () => {
    const story = buildPromiseStory(fixtureInput());
    expect(story.counts.dueToday).toBe(config.demo_due_today);
    expect(story.counts.inGrace).toBe(config.demo_in_grace);
    expect(story.counts.brokenLastSeven).toBe(config.demo_broken_last_seven);
    expect(story.counts.keptHistory).toBe(config.demo_kept_history);
    // Within-three-days: open promises promised asOf+1..+3.
    const withinThree = story.promises.filter(
      (p) => p.status === 'open' && p.promisedDate > '2026-11-07' && p.promisedDate <= '2026-11-10'
    );
    expect(withinThree.length).toBe(config.demo_within_three_days);
    expect(story.counts.open).toBe(
      config.demo_due_today + config.demo_within_three_days + config.demo_in_grace
    );
  });

  it('never stores a status the nightly recompute would change (A63 contract)', () => {
    const story = buildPromiseStory(fixtureInput());
    for (const promise of story.promises) {
      const loan = fixtureInput().loans.find((entry) => entry.loanId === promise.loanId)!;
      const paid = (fixtureInput().paymentsByLoan.get(promise.loanId!) ?? [])
        .filter((payment) => payment.dateKey >= promise.createdAt!.toISOString().slice(0, 10))
        .reduce((sum, payment) => sum + payment.amountPaise, 0);
      const derived = deriveStatusForTest(promise.status!, promise.promisedDate!, promise.promisedAmount!, paid, loan.status === 'cleared');
      expect(derived).toBe(promise.status);
    }
  });

  it('links every promise to a source event and every event to a known loan and officer', () => {
    const story = buildPromiseStory(fixtureInput());
    const eventIds = new Set(story.events.map((event) => event.id));
    const loanIds = new Set(fixtureInput().loans.map((loan) => loan.loanId));
    for (const promise of story.promises) {
      expect(eventIds.has(promise.sourceEventId!)).toBe(true);
      expect(loanIds.has(promise.loanId!)).toBe(true);
      const sourceEvent = story.events.find((event) => event.id === promise.sourceEventId)!;
      expect(sourceEvent.outcome).toBe('promise_to_pay');
      expect(sourceEvent.officerId).toBe(promise.officerId);
    }
    for (const event of story.events) {
      expect(loanIds.has(event.loanId!)).toBe(true);
    }
  });

  it('keeps promised dates off Sundays, terminal ones in the past, open ones within reach', () => {
    const story = buildPromiseStory(fixtureInput());
    for (const promise of story.promises) {
      expect(isSundayIst(promise.promisedDate!)).toBe(false);
      expect(promise.promisedDate! >= '2026-08-10').toBe(true);
      if (promise.status === 'open') {
        // Due today / in grace sit at or before asOf; the within-three-days
        // batch may reach asOf+3 (rolling past a Sunday to asOf+4).
        expect(promise.promisedDate! <= '2026-11-11').toBe(true);
      } else {
        expect(promise.promisedDate! <= '2026-11-07').toBe(true);
        expect(promiseDeadline(promise.promisedDate!, promise.graceDays!) < '2026-11-07').toBe(true);
      }
    }
  });

  it('spreads the demo story over the demo officers and leaves no open promise twice on one loan', () => {
    const story = buildPromiseStory(fixtureInput());
    const openLoans = story.promises.filter((p) => p.status === 'open').map((p) => p.loanId);
    expect(new Set(openLoans).size).toBe(openLoans.length); // one open promise per loan
    const demoPromises = story.promises.filter((p) => [RAHUL, NEHA].includes(p.officerId!));
    expect(demoPromises.length).toBeGreaterThan(10); // the chips see a rich day
  });

  it('flags the violation share outside the window, a handful of BLOCKED events, and Hindi-only notes', () => {
    const story = buildPromiseStory(fixtureInput());
    expect(story.counts.violations).toBeGreaterThan(0);
    expect(story.counts.violations / story.counts.eventsTotal).toBeLessThan(0.15); // "about 3%"
    expect(story.counts.blocked).toBe(config.blocked_events);
    const blocked = story.events.filter((event) => event.kind === 'BLOCKED');
    for (const event of blocked) {
      expect(event.complianceStatus).toBe('VIOLATION_DETECTED');
      expect(event.withinWindow).toBe(false);
    }
    expect(story.counts.hindiNotes).toBeGreaterThan(0);
    const hindiNotes = story.events.filter((event) => event.note !== null).map((event) => event.note!);
    expect(hindiNotes.some((note) => /[\u0900-\u097F]/.test(note))).toBe(true);
  });

  it('is deterministic for a fixed seed: same rng, same ids and rows', () => {
    const a = buildPromiseStory(fixtureInput());
    const b = buildPromiseStory(fixtureInput());
    expect(a.promises.map((p) => p.id)).toEqual(b.promises.map((p) => p.id));
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(a.counts).toEqual(b.counts);
  });

  it('refuses a Sunday as-of: the demo story needs a working day', () => {
    expect(() => buildPromiseStory({ ...fixtureInput(), asOf: '2026-11-08' })).toThrow(/non-Sunday as-of/);
  });

  it('names the demo accounts it relies on (the chips keep their step 0.5 links)', () => {
    const officerAccounts = DEMO_ACCOUNTS.filter((account) => account.officerUser && !account.createsOfficer);
    expect(officerAccounts.map((account) => account.officerName)).toEqual(['Rahul Chouhan', 'Neha Solanki']);
  });
});

import { derivePromiseStatus } from '../../src/shared/promiseState.js';
function deriveStatusForTest(
  stored: string,
  promisedDate: string,
  promisedAmount: number,
  paid: number,
  cleared: boolean
): string {
  return derivePromiseStatus(
    {
      status: stored === 'open' ? 'open' : (stored as 'open'),
      promisedDate,
      graceDays: 1,
      promisedAmount,
      paidAmount: paid,
      loanCleared: cleared
    },
    '2026-11-07'
  );
}
