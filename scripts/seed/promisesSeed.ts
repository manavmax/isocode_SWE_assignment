/**
 * Seed part 2 generator (SPEC 12 + 14, prompt 11 item 4): contact events and
 * promises for the 90-day loan history, PURE — every input is injected (the
 * loan rows come from the database the import just wrote, the payments are
 * the lms_delta rows the importer inferred, the rng and config come from the
 * run) so offline tests drive the exact code main.ts runs.
 *
 * Consistency contract (A63): a stored status must be the one the nightly
 * recompute (src/server/jobs/nightly.ts) derives from the same data —
 * `kept` only on loans that cleared or whose payments since creation cover
 * >= 95% of the promised amount; `broken`/`broken_part` graded by the same
 * paid ratio; nothing terminal before its deadline. The generator therefore
 * DERIVES statuses instead of rolling dice for them: the dice pick how many
 * promises a loan attracts (Poisson, capped) and whether a slot WANTS to be
 * kept (band rates 68/58/45 by DPD bucket), and the payment data has the
 * final word — a kept wish without payment support becomes a broken_part or
 * broken promise with a smaller promised amount, never an inconsistent row.
 *
 * Demo story at the as-of date (config counts, exact): promises due today,
 * within three days, in grace, broken in the last seven days, and kept
 * history — spread across the officers of the chosen loans, weighted toward
 * the demo officers (Rahul/Neha) so their chips show a rich day, while the
 * joiner (no territory, no loans) stays empty by construction. Events carry
 * the SPEC 14 flavour: a violation share outside the 08:00-19:00 window
 * (compliance VIOLATION_DETECTED, recorded never discarded), a handful of
 * BLOCKED attempts, and Hindi-only notes. superseded/disputed rows are
 * deliberately NOT seeded — the demo's one-open-promise invariant stays
 * trivially safe and those statuses are covered by unit tests.
 */
import { contactEvents, promises as promisesTable } from '../../src/server/db/schema.js';
import { CONTACT_WINDOW_RULE_CODE, ruleSetFor } from '../../src/shared/contactWindow.js';
import { addIstDays, isSundayIst, nextWorkingDayIst } from '../../src/shared/promises.js';
import { derivePromiseStatus, promiseDeadline } from '../../src/shared/promiseState.js';
import type { PromiseStatus } from '../../src/shared/types.js';
import type { SeedConfig } from './config.js';
import type { Rng } from './rng.js';

/** The generator emits insert-ready rows: the drizzle infer types keep the
 *  column names and enums honest at compile time. */
export type SeedContactEvent = typeof contactEvents.$inferInsert;
export type SeedPromiseRow = typeof promisesTable.$inferInsert;

export interface SeedLoanRow {
  loanId: string;
  officerId: string;
  borrowerName: string;
  /** Paise, end state (A11). */
  overdueAmount: number;
  outstanding: number;
  bucket: string;
  status: 'overdue' | 'cleared' | 'queue';
  /** For cleared loans: the IST date the loan left the book (its clearance
   *  payment posts on it). Promises on a cleared loan must be created before
   *  this day to see the payment. */
  clearedOn?: string;
}

export interface SeedPayment {
  dateKey: string;
  amountPaise: number;
}

export interface PromiseSeedStory {
  events: SeedContactEvent[];
  promises: SeedPromiseRow[];
  counts: {
    promisesTotal: number;
    open: number;
    kept: number;
    broken: number;
    brokenPart: number;
    eventsTotal: number;
    violations: number;
    blocked: number;
    hindiNotes: number;
    dueToday: number;
    inGrace: number;
    brokenLastSeven: number;
    keptHistory: number;
    keptRate: number | null;
  };
}

/** Malwa-flavoured Hindi-only notes (A1 fictional); a share of events carry
 *  these verbatim so the UI proves its bilingual fallbacks. */
const HINDI_NOTES = [
  'गारंटर से बात हुई, शुक्रवार को भुगतान',
  'किसान भाई बोले — फसल बिकने के बाद पैसे देंगे',
  'दुकान बंद थी, पड़ोसी से पता चला गाँव गए हैं',
  'भाभीजी ने कहा अगले हफ्ते मंडी से भुगतान',
  'नमकीन कारखाने में माल तैयार, भुगतान होगा',
  'फोन बार-बार कट रहा है, शाम को कोशिश करेंगे'
];

const CONTACT_OUTCOME_MIX: readonly { outcome: string; weight: number }[] = [
  { outcome: 'dialled', weight: 30 },
  { outcome: 'paid', weight: 15 },
  { outcome: 'not_reachable', weight: 25 },
  { outcome: 'refused', weight: 12 },
  { outcome: 'dispute', weight: 5 },
  { outcome: 'wrong_number', weight: 8 },
  { outcome: 'promise_to_pay', weight: 5 }
];

const KEPT_RATE_BY_BUCKET: Record<string, 'kept_rate_b1' | 'kept_rate_b2' | 'kept_rate_b3'> = {
  '1-30': 'kept_rate_b1',
  '31-60': 'kept_rate_b2',
  '61-90': 'kept_rate_b3',
  '90+': 'kept_rate_b3'
};

function pickWeighted(rng: Rng, entries: readonly { weight: number }[]): number {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * total;
  for (let i = 0; i < entries.length; i += 1) {
    roll -= entries[i]!.weight;
    if (roll < 0) {
      return i;
    }
  }
  return entries.length - 1;
}

function poisson(rng: Rng, lambda: number): number {
  // Knuth's small-lambda sampler.
  const limit = Math.exp(-lambda);
  let count = 0;
  let product = rng();
  while (product > limit) {
    count += 1;
    product *= rng();
  }
  return count;
}

/** Deterministic uuid v4 from the rng — same seed, same ids, so a rerun
 *  without --reset collides harmlessly on ON CONFLICT DO NOTHING. */
function rngUuid(rng: Rng): string {
  let hex = '';
  for (let i = 0; i < 32; i += 1) {
    hex += Math.floor(rng() * 16).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** UTC instant of an IST wall clock (date key + hour) — attempted_at_ist is
 *  a timestamptz; the seed writes real instants, never strings. */
function istWallClock(dateKey: string, hour: number, minute: number): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + (hour * 60 + minute - 330) * 60_000);
}

export interface PromiseSeedInput {
  loans: readonly SeedLoanRow[];
  paymentsByLoan: ReadonlyMap<string, readonly SeedPayment[]>;
  windowStart: string;
  asOf: string;
  rng: Rng;
  config: SeedConfig['promises'];
  /** Officer ids of the demo chips with loans (Rahul, Neha) — the demo
   *  story weights their loans so each demo officer has a rich day. */
  demoOfficerIds: readonly string[];
}

export function buildPromiseStory(input: PromiseSeedInput): PromiseSeedStory {
  const { rng, config, asOf, windowStart } = input;
  if (isSundayIst(asOf)) {
    throw new Error('promises: the demo story needs a non-Sunday as-of date');
  }
  const overdueLoans = input.loans.filter((loan) => loan.status === 'overdue' && loan.overdueAmount > 0);
  const clearedLoans = input.loans.filter((loan) => loan.status === 'cleared');

  const paidSince = (loanId: string, dateKey: string): number =>
    (input.paymentsByLoan.get(loanId) ?? []).reduce((sum, payment) => (payment.dateKey >= dateKey ? sum + payment.amountPaise : sum), 0);

  const events: SeedContactEvent[] = [];
  const promises: SeedPromiseRow[] = [];
  const openLoans = new Set<string>(); // one open promise per loan
  const counts = {
    promisesTotal: 0,
    open: 0,
    kept: 0,
    broken: 0,
    brokenPart: 0,
    eventsTotal: 0,
    violations: 0,
    blocked: 0,
    hindiNotes: 0,
    dueToday: 0,
    inGrace: 0,
    brokenLastSeven: 0,
    keptHistory: 0,
    keptRate: null as number | null
  };

  function pushEvent(loan: SeedLoanRow, dateKey: string, compliant: boolean, kind: SeedContactEvent['kind'], outcome: string, note: string | null): SeedContactEvent {
    // Compliant events sit inside 08:00-19:00 IST; violations land outside
    // (evening or early morning) — recorded with VIOLATION_DETECTED, never
    // discarded (SPEC 7).
    const hour = compliant ? 9 + Math.floor(rng() * 10) : rng() < 0.5 ? 5 + Math.floor(rng() * 3) : 20 + Math.floor(rng() * 3);
    const at = istWallClock(dateKey, hour, Math.floor(rng() * 60));
    const event: SeedContactEvent = {
      id: rngUuid(rng),
      loanId: loan.loanId,
      officerId: loan.officerId,
      kind,
      outcome,
      attemptedAtDevice: at, // zero skew: the seed's clocks agree
      deviceTzOffsetMinutes: 330,
      skewEstimateMs: null,
      syncedAt: new Date(at.getTime() + 30 * 60_000),
      attemptedAtIst: at,
      withinWindow: compliant,
      timeConfidence: 'high',
      ruleSet: ruleSetFor(dateKey).id,
      lat: 22.7 + rng() * 0.5,
      lng: 75.8 + rng() * 0.3,
      accuracyM: 8 + Math.floor(rng() * 30),
      gpsStatus: 'ok',
      note,
      complianceStatus: compliant ? 'COMPLIANT' : 'VIOLATION_DETECTED'
    };
    events.push(event);
    return event;
  }

  function hindiNote(): string | null {
    if (rng() >= config.hindi_note_share) {
      return null;
    }
    counts.hindiNotes += 1;
    return HINDI_NOTES[Math.floor(rng() * HINDI_NOTES.length)]!;
  }

  function pushPromise(
    loan: SeedLoanRow,
    sourceEventId: string,
    promisedDate: string,
    promisedAmount: number,
    status: PromiseStatus,
    createdAt: Date,
    creationIst: string
  ): SeedPromiseRow {
    const row: SeedPromiseRow = {
      id: rngUuid(rng),
      loanId: loan.loanId,
      officerId: loan.officerId,
      sourceEventId,
      promisedAmount,
      promisedDate,
      graceDays: 1,
      status,
      resolvedAt: status === 'open' ? null : istWallClock(promiseDeadline(promisedDate, 1), 12, 0),
      // "Payments since creation" on IST date keys — never the UTC date of
      // the creation instant (a 05:00 IST violation event lands on the
      // previous UTC day).
      paidAmount: status === 'open' ? null : paidSince(loan.loanId, creationIst),
      createdAt
    };
    promises.push(row);
    counts.promisesTotal += 1;
    counts[status === 'open' ? 'open' : status === 'kept' ? 'kept' : status === 'broken' ? 'broken' : 'brokenPart'] += 1;
    return row;
  }

  /** Status derived exactly as the nightly job will — never dice. */
  function deriveFor(loan: SeedLoanRow, promisedDate: string, promisedAmount: number, createdAtIst: string): PromiseStatus {
    return derivePromiseStatus(
      {
        status: 'open',
        promisedDate,
        graceDays: 1,
        promisedAmount,
        paidAmount: paidSince(loan.loanId, createdAtIst),
        loanCleared: loan.status === 'cleared'
      },
      asOf
    );
  }

  /** The largest promised amount that still derives to `kept` given the
   *  payments visible since `createdAtIst`, or null when even 50% of the
   *  overdue cannot be covered. */
  function keptCeiling(loan: SeedLoanRow, createdAtIst: string): number | null {
    if (loan.status === 'cleared') {
      return Math.min(loan.outstanding, Math.max(loan.overdueAmount, Math.ceil(loan.overdueAmount / 2)));
    }
    const paid = paidSince(loan.loanId, createdAtIst);
    const ceiling = Math.min(loan.outstanding, Math.floor(paid / 0.95));
    const minimum = Math.ceil(loan.overdueAmount / 2);
    return ceiling >= minimum && ceiling > 0 ? ceiling : null;
  }

  function promiseEvent(loan: SeedLoanRow, dateKey: string, compliant = true): { eventId: string; createdAt: Date } {
    const event = pushEvent(loan, dateKey, compliant, rng() < 0.7 ? 'CALL' : 'VISIT', 'promise_to_pay', hindiNote());
    return { eventId: event.id!, createdAt: event.attemptedAtIst };
  }

  function makeKept(loan: SeedLoanRow, creationIst: string, promisedDate: string): boolean {
    const ceiling = keptCeiling(loan, creationIst);
    if (ceiling === null) {
      return false;
    }
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.min(ceiling, Math.floor(ceiling * (0.8 + rng() * 0.2))));
    const { eventId, createdAt } = promiseEvent(loan, creationIst);
    const status = deriveFor(loan, promisedDate, promisedAmount, creationIst);
    if (status !== 'kept' && loan.status !== 'cleared') {
      return false; // payment data disagreed with the wish — no row at all
    }
    pushPromise(loan, eventId, promisedDate, promisedAmount, loan.status === 'cleared' ? 'kept' : status, createdAt, creationIst);
    return true;
  }

  function makeBroken(loan: SeedLoanRow, creationIst: string, promisedDate: string): void {
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.floor(loan.overdueAmount * (0.5 + rng() * 0.4)));
    const { eventId, createdAt } = promiseEvent(loan, creationIst);
    const status = deriveFor(loan, promisedDate, promisedAmount, creationIst);
    pushPromise(loan, eventId, promisedDate, promisedAmount, status === 'open' ? 'open' : status, createdAt, creationIst);
  }

  function backgroundDate(): string {
    // Background promises live well before the demo window so the two never
    // fight over the same days.
    const spanDays = Math.max(
      1,
      Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)) / 86_400_000) - 17
    );
    const date = new Date(Date.parse(`${windowStart}T00:00:00Z`) + (3 + Math.floor(rng() * spanDays)) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return nextWorkingDayIst(date);
  }

  function futurePromisedDate(minOffset: number, maxOffset: number): string {
    const offset = minOffset + Math.floor(rng() * (maxOffset - minOffset + 1));
    return nextWorkingDayIst(addIstDays(asOf, offset));
  }

  // ---- Pass A: background promises (terminal history) ----
  for (const loan of overdueLoans) {
    const slots = Math.min(config.broken_per_loan_cap, poisson(rng, config.broken_per_loan_lambda));
    const bandKey = KEPT_RATE_BY_BUCKET[loan.bucket] ?? 'kept_rate_b3';
    for (let i = 0; i < slots; i += 1) {
      const creationIst = backgroundDate();
      const promisedDate = nextWorkingDayIst(addIstDays(creationIst, 1 + Math.floor(rng() * 6)));
      if (promisedDate >= asOf) {
        continue;
      }
      const wantsKept = rng() < config[bandKey];
      if (wantsKept) {
        makeKept(loan, creationIst, promisedDate);
      } else {
        makeBroken(loan, creationIst, promisedDate);
      }
    }
  }
  // Cleared loans carry one kept promise each, created before they left the
  // book — a cured loan is the textbook kept promise (SPEC 12).
  for (const loan of clearedLoans) {
    const clearance = loan.clearedOn ?? asOf;
    const latest = addIstDays(clearance, -2);
    const creationIst = latest <= windowStart ? nextWorkingDayIst(windowStart) : latest;
    makeKept(loan, creationIst, nextWorkingDayIst(addIstDays(creationIst, 1 + Math.floor(rng() * 5))));
  }

  // ---- Pass B: the demo story at the as-of date (exact config counts) ----
  function demoLoan(excludeOpen: boolean): SeedLoanRow {
    const pool = overdueLoans.filter((loan) => !(excludeOpen && openLoans.has(loan.loanId)));
    const demoPool = pool.filter((loan) => input.demoOfficerIds.includes(loan.officerId));
    // 60% of the demo story rides on the demo officers' loans (rich day for
    // the chips), the rest spreads across everyone.
    const source = demoPool.length > 0 && rng() < 0.6 ? demoPool : pool;
    return source[Math.floor(rng() * source.length)] ?? pool[0]!;
  }

  function registerOpen(loan: SeedLoanRow): void {
    // counts.open is already tallied by pushPromise; this only tracks the
    // one-open-promise-per-loan invariant.
    openLoans.add(loan.loanId);
  }

  // Due today: promised = asOf, created today.
  for (let i = 0; i < config.demo_due_today; i += 1) {
    const loan = demoLoan(true);
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.floor(loan.overdueAmount * (0.5 + rng() * 0.4)));
    const { eventId, createdAt } = promiseEvent(loan, asOf);
    pushPromise(loan, eventId, asOf, promisedAmount, 'open', createdAt, asOf);
    registerOpen(loan);
    counts.dueToday += 1;
  }
  // Within three days: promised asOf+1..+3 (Sundays roll forward), open.
  for (let i = 0; i < config.demo_within_three_days; i += 1) {
    const loan = demoLoan(true);
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.floor(loan.overdueAmount * (0.5 + rng() * 0.4)));
    const { eventId, createdAt } = promiseEvent(loan, asOf);
    pushPromise(loan, eventId, futurePromisedDate(1, 3), promisedAmount, 'open', createdAt, asOf);
    registerOpen(loan);
  }
  // In grace: promised yesterday, deadline today — still open, still
  // actionable (the client shows them under Due today).
  for (let i = 0; i < config.demo_in_grace; i += 1) {
    const loan = demoLoan(true);
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.floor(loan.overdueAmount * (0.5 + rng() * 0.4)));
    const promisedDate = nextWorkingDayIst(addIstDays(asOf, -1));
    const creationIst = nextWorkingDayIst(addIstDays(promisedDate, -2));
    const { eventId, createdAt } = promiseEvent(loan, creationIst);
    pushPromise(loan, eventId, promisedDate, promisedAmount, 'open', createdAt, creationIst);
    registerOpen(loan);
    counts.inGrace += 1;
  }
  // Broken in the last seven days: promised asOf-8..-4 so the deadline
  // (promised + 1 grace day) sits inside the last seven; resolved then.
  let brokenRecent = 0;
  let brokenAttempts = 0;
  while (brokenRecent < config.demo_broken_last_seven && brokenAttempts < config.demo_broken_last_seven * 6) {
    brokenAttempts += 1;
    const loan = demoLoan(false);
    const promisedDate = nextWorkingDayIst(addIstDays(asOf, -(4 + Math.floor(rng() * 5))));
    if (promiseDeadline(promisedDate, 1) >= asOf) {
      continue;
    }
    const promisedAmount = Math.max(Math.ceil(loan.overdueAmount / 2), Math.floor(loan.overdueAmount * (0.5 + rng() * 0.4)));
    const creationIst = nextWorkingDayIst(addIstDays(promisedDate, -(1 + Math.floor(rng() * 3))));
    const { eventId, createdAt } = promiseEvent(loan, creationIst);
    const status = deriveFor(loan, promisedDate, promisedAmount, creationIst);
    pushPromise(loan, eventId, promisedDate, promisedAmount, status === 'open' ? 'open' : status, createdAt, creationIst);
    if (status !== 'open') {
      brokenRecent += 1;
      counts.brokenLastSeven += 1;
    }
  }
  // Kept history: spread across the whole window; cleared loans first (the
  // textbook case), then overdue loans whose payments support one.
  const keptCandidates: SeedLoanRow[] = [...clearedLoans, ...overdueLoans];
  let keptMade = 0;
  let candidateIndex = 0;
  while (keptMade < config.demo_kept_history && candidateIndex < keptCandidates.length * 3) {
    const loan = keptCandidates[candidateIndex % keptCandidates.length]!;
    candidateIndex += 1;
    const creationIst = backgroundDate();
    const promisedDate = nextWorkingDayIst(addIstDays(creationIst, 1 + Math.floor(rng() * 6)));
    if (promisedDate >= asOf) {
      continue;
    }
    if (makeKept(loan, creationIst, promisedDate)) {
      keptMade += 1;
      counts.keptHistory += 1;
    }
  }

  // ---- Pass C: background contact events + violations + blocked ----
  for (const loan of overdueLoans) {
    const extra = poisson(rng, 1.2);
    for (let i = 0; i < extra; i += 1) {
      const dateKey = backgroundDate();
      const outcome = CONTACT_OUTCOME_MIX[pickWeighted(rng, CONTACT_OUTCOME_MIX)]!.outcome;
      const compliant = rng() >= config.violation_share;
      const kind: SeedContactEvent['kind'] = rng() < 0.6 ? 'CALL' : rng() < 0.6 ? 'VISIT' : 'MESSAGE';
      pushEvent(loan, dateKey, compliant, kind, outcome, hindiNote());
    }
  }
  // A handful of BLOCKED attempts: outside the window, rule-code note,
  // recorded as violations (SPEC 7: the attempt is the compliance record).
  for (let i = 0; i < config.blocked_events; i += 1) {
    const loan = overdueLoans[Math.floor(rng() * overdueLoans.length)]!;
    pushEvent(loan, backgroundDate(), false, 'BLOCKED', 'not_reachable', CONTACT_WINDOW_RULE_CODE);
  }
  counts.eventsTotal = events.length;
  counts.violations = events.filter((event) => event.complianceStatus === 'VIOLATION_DETECTED').length;
  counts.blocked = events.filter((event) => event.kind === 'BLOCKED').length;
  const denominator = counts.kept + counts.broken + counts.brokenPart;
  counts.keptRate = denominator === 0 ? null : counts.kept / denominator;
  return { events, promises, counts };
}
