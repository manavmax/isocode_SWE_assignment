import type { PromiseStatus } from './types.js';

/**
 * Auto-assignment planner (SPEC 10, test-first). Pure: no I/O, no clocks —
 * the run date is an input. Deterministic loan by loan; a rerun on the
 * post-state produces zero changes and zero log entries.
 *
 * Documented readings (docs/assumptions.md A21-A23):
 * - primary officer = territory-resolved officer (locality row beats pincode
 *   row, then prefix tiers); the -0.10 bonus applies only to them.
 * - broken promise = status broken/broken_part with promised_date in the last
 *   14 days; an open promise past its date does not count.
 * - working day = Mon-Sat (Sunday off).
 * - 61+ DPD loans are never rescored while their officer is eligible; only
 *   inactivity, 3+ working-day leave or a data-fix/queue rule moves them.
 * - caps filter candidates: projected > 1.2 excluded; prefer <= 1.0; nobody
 *   under 1.2 -> minimum utilisation + alert.
 */
export const ASSIGNMENT_REASONS = [
  'carry_forward',
  'stays_61plus',
  'new_assigned',
  'reassigned_score',
  'reassigned_inactive',
  'reassigned_leave',
  'reassigned_out_of_territory',
  'revert_return',
  'queue_unmapped',
  'queue_data_fix'
] as const;

export type AssignmentReason = (typeof ASSIGNMENT_REASONS)[number];

export const SOFT_CAP = 1.0;
export const HARD_CAP = 1.2;
export const HYSTERESIS = 0.15;
export const BONUS_PRIMARY = 0.1;
export const BONUS_CURRENT = 0.35;
export const BONUS_AFFINITY = 0.25;
export const RS_TEN_LAKH_PAISE = 100_000_000;
export const LEAVE_MIN_WORKING_DAYS = 3;
const EPSILON = 1e-9;
const BROKEN_PROMISE_STATUSES: ReadonlySet<string> = new Set(['broken', 'broken_part']);
const BROKEN_PROMISE_WINDOW_DAYS = 14;
const PINCODE_RE = /^[1-9][0-9]{5}$/;

export interface AssignmentLoan {
  loanId: string;
  borrowerName: string;
  branchId: string;
  pincode: string | null;
  locality: string | null;
  dpd: number;
  outstanding: number;
  mobile: string | null;
  altMobile: string | null;
  address: string | null;
  assignedOfficerId: string | null;
  homeOfficerId: string | null;
  status: 'overdue' | 'cleared' | 'queue';
}

export interface AssignmentOfficer {
  id: string;
  branchId: string;
  active: boolean;
  capacityPoints: number;
}

export interface AssignmentTerritory {
  branchId: string;
  pincode: string;
  locality: string | null;
  officerId: string;
  rank: number;
}

export interface AssignmentAbsence {
  officerId: string;
  fromDate: string;
  toDate: string;
  coverOfficerId: string | null;
}

export interface AssignmentPromise {
  loanId: string;
  promisedDate: string;
  status: PromiseStatus;
  createdOn: string;
}

export interface AssignmentContact {
  loanId: string;
  attemptedAt: string;
}

export interface AssignmentInput {
  runDate: string;
  loans: readonly AssignmentLoan[];
  officers: readonly AssignmentOfficer[];
  territory: readonly AssignmentTerritory[];
  absences: readonly AssignmentAbsence[];
  promises: readonly AssignmentPromise[];
  contacts: readonly AssignmentContact[];
}

export interface AssignmentDecision {
  loanId: string;
  toOfficerId: string | null;
  homeOfficerId: string | null;
  status: 'overdue' | 'queue';
  changed: boolean;
  reason: AssignmentReason;
  flagged: boolean;
}

export interface AssignmentLogEntry {
  loanId: string;
  runDate: string;
  fromOfficerId: string | null;
  toOfficerId: string | null;
  reason: AssignmentReason;
}

export interface AssignmentAlert {
  code: 'all_officers_over_hard_cap';
  loanId: string;
}

export interface AssignmentPlan {
  decisions: AssignmentDecision[];
  logEntries: AssignmentLogEntry[];
  alerts: AssignmentAlert[];
  outcomesByReason: Record<AssignmentReason, number>;
}

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function loanWeight(loan: Pick<AssignmentLoan, 'dpd' | 'outstanding'>, brokenPromise14d: boolean): number {
  let w = 1;
  if (loan.dpd >= 16) w += 0.5;
  if (loan.dpd >= 31) w += 0.5;
  if (brokenPromise14d) w += 0.5;
  if (loan.outstanding >= RS_TEN_LAKH_PAISE) w += 0.5;
  return w;
}

export function workingDays(fromDate: string, toDate: string): number {
  let count = 0;
  for (let t = toUtcMs(fromDate); t <= toUtcMs(toDate); t += DAY_MS) {
    if (new Date(t).getUTCDay() !== 0) {
      count += 1;
    }
  }
  return count;
}

/**
 * Loans with a promise row whose status is broken or broken_part and whose
 * promised_date is within the last 14 calendar days of the run date (A22:
 * promised-date anchor; deadline and resolution times are not observable
 * while the promise tracker is unbuilt).
 */
export function brokenPromisesInWindow(promises: readonly AssignmentPromise[], runDate: string): Set<string> {
  const floor = addDays(runDate, -BROKEN_PROMISE_WINDOW_DAYS);
  const ids = new Set<string>();
  for (const p of promises) {
    if (BROKEN_PROMISE_STATUSES.has(p.status) && p.promisedDate >= floor && p.promisedDate <= runDate) {
      ids.add(p.loanId);
    }
  }
  return ids;
}

function normaliseBorrower(name: string): string {
  return name.trim().toLowerCase();
}

export function planAssignment(input: AssignmentInput): AssignmentPlan {
  const officerById = new Map(input.officers.map((o) => [o.id, o]));
  const outcomesByReason = Object.fromEntries(ASSIGNMENT_REASONS.map((r) => [r, 0])) as Record<AssignmentReason, number>;

  const broken14ByLoan = brokenPromisesInWindow(input.promises, input.runDate);
  const openPromiseByLoan = new Set<string>();
  for (const p of input.promises) {
    if (p.status === 'open') {
      openPromiseByLoan.add(p.loanId);
    }
  }

  const weights = new Map<string, number>();
  const borrowerHoldings = new Map<string, Map<string, number>>();
  const weightOfLoan = new Map<string, number>();
  const borrowerKey = new Map<string, string>();
  for (const l of input.loans) {
    const w = loanWeight(l, broken14ByLoan.has(l.loanId));
    weightOfLoan.set(l.loanId, w);
    const key = normaliseBorrower(l.borrowerName);
    borrowerKey.set(l.loanId, key);
    if (l.status === 'overdue' && l.assignedOfficerId !== null) {
      weights.set(l.assignedOfficerId, (weights.get(l.assignedOfficerId) ?? 0) + w);
      const holdings = borrowerHoldings.get(l.assignedOfficerId) ?? new Map<string, number>();
      holdings.set(key, (holdings.get(key) ?? 0) + 1);
      borrowerHoldings.set(l.assignedOfficerId, holdings);
    }
  }

  const leaveCoveringRunDate = (officerId: string): AssignmentAbsence | null => {
    const covering = input.absences.filter(
      (a) => a.officerId === officerId && a.fromDate <= input.runDate && input.runDate <= a.toDate
    );
    if (covering.length === 0) {
      return null;
    }
    return covering.reduce((max, a) => (workingDays(a.fromDate, a.toDate) > workingDays(max.fromDate, max.toDate) ? a : max));
  };
  const mostRecentEndedAbsence = (officerId: string): AssignmentAbsence | null => {
    const ended = input.absences
      .filter((a) => a.officerId === officerId && a.toDate < input.runDate)
      .sort((a, b) => b.toDate.localeCompare(a.toDate));
    return ended[0] ?? null;
  };
  const onLeave3Plus = (officerId: string): boolean => {
    const leave = leaveCoveringRunDate(officerId);
    return leave !== null && workingDays(leave.fromDate, leave.toDate) >= LEAVE_MIN_WORKING_DAYS;
  };

  const eligibleOfficersFor = (loan: AssignmentLoan): string[] => {
    const rows = input.territory.filter((t) => t.branchId === loan.branchId);
    const usable = (id: string): boolean => {
      const o = officerById.get(id);
      return o !== undefined && o.active && o.branchId === loan.branchId && o.capacityPoints > 0 && !onLeave3Plus(id);
    };
    const officersOf = (rs: readonly AssignmentTerritory[]): string[] => {
      const ids = [...new Set(rs.map((r) => r.officerId))];
      return ids.filter(usable);
    };
    if (loan.pincode === null || !PINCODE_RE.test(loan.pincode)) {
      return [];
    }
    if (loan.locality !== null) {
      const exact = rows.filter((t) => t.pincode === loan.pincode && t.locality === loan.locality);
      if (exact.length > 0) {
        return officersOf(exact);
      }
    }
    const generic = rows.filter((t) => t.pincode === loan.pincode && t.locality === null);
    if (generic.length > 0) {
      return officersOf(generic);
    }
    for (const len of [5, 4, 3]) {
      const prefix = loan.pincode.slice(0, len);
      const tier = rows.filter((t) => t.pincode.startsWith(prefix));
      if (tier.length > 0) {
        return officersOf(tier);
      }
    }
    return [];
  };

  const primaryOfficerFor = (loan: AssignmentLoan): string | null => {
    const rows = input.territory.filter((t) => t.branchId === loan.branchId);
    const best = (rs: readonly AssignmentTerritory[]): string | null =>
      rs.length === 0
        ? null
        : [...rs].sort((a, b) => a.rank - b.rank || a.officerId.localeCompare(b.officerId))[0]!.officerId;
    if (loan.pincode === null || !PINCODE_RE.test(loan.pincode)) {
      return null;
    }
    if (loan.locality !== null) {
      const exact = rows.filter((t) => t.pincode === loan.pincode && t.locality === loan.locality);
      if (exact.length > 0) {
        return best(exact);
      }
    }
    const generic = rows.filter((t) => t.pincode === loan.pincode && t.locality === null);
    if (generic.length > 0) {
      return best(generic);
    }
    for (const len of [5, 4, 3]) {
      const prefix = loan.pincode.slice(0, len);
      const tier = rows.filter((t) => t.pincode.startsWith(prefix));
      if (tier.length > 0) {
        return best(tier);
      }
    }
    return null;
  };

  const projectedUtilisation = (officerId: string, loan: AssignmentLoan, includesLoan: boolean): number => {
    const o = officerById.get(officerId)!;
    const held = weights.get(officerId) ?? 0;
    const total = includesLoan ? held : held + (weightOfLoan.get(loan.loanId) ?? 0);
    return total / o.capacityPoints;
  };
  const otherBorrowerHoldings = (officerId: string, loan: AssignmentLoan): number => {
    const holdings = borrowerHoldings.get(officerId);
    if (!holdings) {
      return 0;
    }
    const count = holdings.get(normaliseBorrower(loan.borrowerName)) ?? 0;
    return loan.assignedOfficerId === officerId ? Math.max(0, count - 1) : count;
  };
  const score = (officerId: string, loan: AssignmentLoan, primary: string | null, includesLoan: boolean): number => {
    let s = projectedUtilisation(officerId, loan, includesLoan);
    if (officerId === primary) s -= BONUS_PRIMARY;
    if (officerId === loan.assignedOfficerId) s -= BONUS_CURRENT;
    if (otherBorrowerHoldings(officerId, loan) > 0) s -= BONUS_AFFINITY;
    return s;
  };

  const byScoreThenId = (loan: AssignmentLoan, primary: string | null, candidates: string[], includesLoan: boolean): string | null =>
    [...candidates]
      .map((id) => ({ id, s: score(id, loan, primary, includesLoan) }))
      .sort((a, b) => a.s - b.s || a.id.localeCompare(b.id))[0]?.id ?? null;

  /** Cap tiers: prefer candidates at or under the soft cap, then under the
   *  hard cap; nobody under the hard cap -> minimum utilisation + alert. */
  const chooseUnderCaps = (
    loan: AssignmentLoan,
    primary: string | null,
    candidates: string[],
    includesLoan: boolean
  ): { officerId: string | null; alert: boolean } => {
    if (candidates.length === 0) {
      return { officerId: null, alert: false };
    }
    const soft = candidates.filter((id) => projectedUtilisation(id, loan, includesLoan) <= SOFT_CAP + EPSILON);
    const pool = soft.length > 0 ? soft : candidates.filter((id) => projectedUtilisation(id, loan, includesLoan) <= HARD_CAP + EPSILON);
    if (pool.length === 0) {
      const min = [...candidates].sort(
        (a, b) => projectedUtilisation(a, loan, includesLoan) - projectedUtilisation(b, loan, includesLoan) || a.localeCompare(b)
      )[0]!;
      return { officerId: min, alert: true };
    }
    return { officerId: byScoreThenId(loan, primary, pool, includesLoan), alert: false };
  };

  const noPhoneNoAddress = (loan: AssignmentLoan): boolean =>
    loan.mobile === null && loan.altMobile === null && loan.address === null;

  const decisions: AssignmentDecision[] = [];
  const logEntries: AssignmentLogEntry[] = [];
  const alerts: AssignmentAlert[] = [];
  const runDate = input.runDate;

  const decide = (
    loan: AssignmentLoan,
    toOfficerId: string | null,
    homeOfficerId: string | null,
    status: 'overdue' | 'queue',
    changed: boolean,
    reason: AssignmentReason,
    flagged = false
  ): AssignmentDecision => {
    const decision: AssignmentDecision = { loanId: loan.loanId, toOfficerId, homeOfficerId, status, changed, reason, flagged };
    decisions.push(decision);
    outcomesByReason[reason] += 1;
    if (changed) {
      logEntries.push({ loanId: loan.loanId, runDate, fromOfficerId: loan.assignedOfficerId, toOfficerId, reason });
    }
    return decision;
  };

  // weights move as decisions land so that later loans in the batch see the
  // updated loads (step 2 processes by descending outstanding). Borrower
  // holdings move with them for the same reason: a borrower's loan that moved
  // earlier in this run must count as companion-loan affinity for their later
  // loans, or the rerun would flip the later loan and log it.
  const applyDecisionToWeights = (loan: AssignmentLoan, from: string | null, to: string | null): void => {
    const w = weightOfLoan.get(loan.loanId) ?? 0;
    if (from !== null) {
      weights.set(from, Math.max(0, (weights.get(from) ?? 0) - w));
      const holdings = borrowerHoldings.get(from);
      const key = borrowerKey.get(loan.loanId);
      if (holdings && key !== undefined) {
        const count = (holdings.get(key) ?? 0) - 1;
        if (count > 0) {
          holdings.set(key, count);
        } else {
          holdings.delete(key);
        }
      }
    }
    if (to !== null) {
      weights.set(to, (weights.get(to) ?? 0) + w);
      const holdings = borrowerHoldings.get(to) ?? new Map<string, number>();
      const key = borrowerKey.get(loan.loanId);
      if (key !== undefined) {
        holdings.set(key, (holdings.get(key) ?? 0) + 1);
        borrowerHoldings.set(to, holdings);
      }
    }
  };

  const processLoan = (loan: AssignmentLoan): void => {
    const current = loan.assignedOfficerId;
    const home = loan.homeOfficerId;

    if (noPhoneNoAddress(loan)) {
      decide(loan, null, home, 'queue', current !== null || loan.status !== 'queue', 'queue_data_fix');
      applyDecisionToWeights(loan, current, null);
      return;
    }
    const invalidPincode = loan.pincode === null || !PINCODE_RE.test(loan.pincode ?? '');
    const eligible = eligibleOfficersFor(loan);
    // A loan with an assignee never queues here: the carry-forward branches
    // below decide its keeper even when the territory officer is on leave or
    // the pool is empty. Only new and orphaned loans route to the queue when
    // nobody on the loan's territory rows can take it (A24).
    if (current === null && (invalidPincode || eligible.length === 0)) {
      decide(loan, null, home, 'queue', loan.status !== 'queue', 'queue_unmapped');
      applyDecisionToWeights(loan, current, null);
      return;
    }

    const primary = primaryOfficerFor(loan);

    if (current !== null && current !== home && home !== null) {
      // The loan sits with a cover officer (or a stale home). Resolve by the
      // home officer's leave story.
      const homeOfficer = officerById.get(home);
      const homeUsable = homeOfficer !== undefined && homeOfficer.active && homeOfficer.branchId === loan.branchId;
      if (!homeUsable) {
        // Dead home: make the current state permanent without churn.
        decide(loan, current, current, 'overdue', false, 'carry_forward');
        return;
      }
      if (onLeave3Plus(home)) {
        decide(loan, current, home, 'overdue', false, 'carry_forward');
        return;
      }
      if (eligible.includes(home)) {
        const ended = mostRecentEndedAbsence(home);
        if (ended === null) {
          decide(loan, current, home, 'overdue', false, 'carry_forward');
          return;
        }
        const window = { from: ended.fromDate, to: ended.toDate };
        const touched =
          input.contacts.some((c) => c.loanId === loan.loanId && c.attemptedAt >= window.from && c.attemptedAt <= window.to) ||
          input.promises.some((p) => p.loanId === loan.loanId && p.createdOn >= window.from && p.createdOn <= window.to);
        if (touched || openPromiseByLoan.has(loan.loanId)) {
          decide(loan, current, home, 'overdue', false, 'carry_forward');
          return;
        }
        decide(loan, home, home, 'overdue', true, 'revert_return');
        applyDecisionToWeights(loan, current, home);
        return;
      }
      // Home is alive but cannot take the loan back: treat as orphaned.
      const chosen = chooseUnderCaps(loan, primary, eligible, false);
      if (chosen.alert) {
        alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
      }
      if (chosen.officerId === null || chosen.officerId === current) {
        decide(loan, chosen.officerId ?? current, current, 'overdue', false, 'carry_forward');
        return;
      }
      decide(loan, chosen.officerId, chosen.officerId, 'overdue', true, 'reassigned_score');
      applyDecisionToWeights(loan, current, chosen.officerId);
      return;
    }

    if (current !== null) {
      const officer = officerById.get(current);
      if (officer === undefined || !officer.active) {
        const chosen = chooseUnderCaps(loan, primary, eligible, false);
        if (chosen.alert) {
          alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
        }
        if (chosen.officerId !== null && chosen.officerId !== current) {
          decide(loan, chosen.officerId, chosen.officerId, 'overdue', true, 'reassigned_inactive');
          applyDecisionToWeights(loan, current, chosen.officerId);
          return;
        }
        decide(loan, current, home, 'overdue', false, 'carry_forward');
        return;
      }
      if (onLeave3Plus(current)) {
        const leave = leaveCoveringRunDate(current)!;
        const cover = leave.coverOfficerId;
        const coverOfficer = cover !== null ? officerById.get(cover) : undefined;
        const coverUsable =
          cover !== null &&
          coverOfficer !== undefined &&
          coverOfficer.active &&
          coverOfficer.branchId === loan.branchId &&
          !onLeave3Plus(cover);
        if (coverUsable && cover !== current) {
          const changed = cover !== current;
          decide(loan, cover, home, 'overdue', changed, 'reassigned_leave');
          if (changed) {
            applyDecisionToWeights(loan, current, cover);
          }
          return;
        }
        const pool = eligible.filter((id) => id !== current);
        const chosen = chooseUnderCaps(loan, primary, pool, false);
        if (chosen.alert) {
          alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
        }
        if (chosen.officerId !== null && chosen.officerId !== current) {
          decide(loan, chosen.officerId, home, 'overdue', true, 'reassigned_leave');
          applyDecisionToWeights(loan, current, chosen.officerId);
          return;
        }
        decide(loan, current, home, 'overdue', false, 'carry_forward');
        return;
      }
      if (!eligible.includes(current)) {
        const chosen = chooseUnderCaps(loan, primary, eligible, false);
        if (chosen.alert) {
          alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
        }
        if (chosen.officerId !== null && chosen.officerId !== current) {
          decide(loan, chosen.officerId, chosen.officerId, 'overdue', true, 'reassigned_out_of_territory');
          applyDecisionToWeights(loan, current, chosen.officerId);
          return;
        }
        decide(loan, current, home, 'overdue', false, 'carry_forward');
        return;
      }
      if (loan.dpd >= 61) {
        decide(loan, current, home, 'overdue', false, 'stays_61plus', true);
        return;
      }
      const incumbentScore = score(current, loan, primary, true);
      const pool = eligible.filter((id) => id !== current);
      const challenger = chooseUnderCaps(loan, primary, pool, false);
      if (challenger.alert) {
        alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
      }
      if (challenger.officerId !== null) {
        const challengerScore = score(challenger.officerId, loan, primary, false);
        if (incumbentScore - challengerScore >= HYSTERESIS - EPSILON) {
          decide(loan, challenger.officerId, challenger.officerId, 'overdue', true, 'reassigned_score');
          applyDecisionToWeights(loan, current, challenger.officerId);
          return;
        }
      } else if (challenger.officerId === null && pool.length > 0) {
        // Every challenger is over the hard cap; hysteresis compares against
        // the minimum-utilisation challenger (alert already emitted).
        const minUtil = [...pool].sort(
          (a, b) => projectedUtilisation(a, loan, false) - projectedUtilisation(b, loan, false) || a.localeCompare(b)
        )[0]!;
        const challengerScore = score(minUtil, loan, primary, false);
        if (incumbentScore - challengerScore >= HYSTERESIS - EPSILON) {
          decide(loan, minUtil, minUtil, 'overdue', true, 'reassigned_score');
          applyDecisionToWeights(loan, current, minUtil);
          return;
        }
      }
      decide(loan, current, home, 'overdue', false, 'carry_forward');
      return;
    }

    // New or orphaned loan (no assignee).
    const chosen = chooseUnderCaps(loan, primary, eligible, false);
    if (chosen.alert) {
      alerts.push({ code: 'all_officers_over_hard_cap', loanId: loan.loanId });
    }
    if (chosen.officerId === null) {
      decide(loan, null, home, 'queue', loan.status !== 'queue', 'queue_unmapped');
      return;
    }
    // A new assignment owns home_officer_id outright (A25): the CSV officer
    // column is bookkeeping and must not survive as the loan's home, or the
    // next run would see current != home and reroute through the cover story.
    decide(loan, chosen.officerId, chosen.officerId, 'overdue', true, 'new_assigned');
    applyDecisionToWeights(loan, null, chosen.officerId);
  };

  const carryForward = input.loans.filter((l) => l.status === 'overdue' && l.assignedOfficerId !== null);
  const step2 = input.loans
    .filter((l) => l.status === 'queue' || (l.status === 'overdue' && l.assignedOfficerId === null))
    .sort((a, b) => b.outstanding - a.outstanding || a.loanId.localeCompare(b.loanId));

  for (const l of carryForward) {
    processLoan(l);
  }
  for (const l of step2) {
    processLoan(l);
  }

  return { decisions, logEntries, alerts, outcomesByReason };
}
