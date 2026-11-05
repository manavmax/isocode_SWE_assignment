/**
 * Loan universe generation (prompt 8; SPEC 14, A5, A24). Pure: no DB, no
 * clock — everything derives from (rng, config, seed).
 *
 * 263 loans = 180 end-active (Indore 90, Ujjain branch 55 = 35 city + 20
 * Ratlam, Dewas 35) + 83 cured cohort members (cohort 136 = 68 + 41 + 27;
 * cured = cohort - roll - stay). Destiny classes are pinned to the
 * CONFIGURED counts so the roll-rate calibration is exact, not dice:
 *   roll 31 (b31-60 at end), stay 22 (cure, re-enter 1-30), cure 83
 *   (absent at end), early 30 (61-90 at end), fresh 97 (the rest).
 *
 * Day-offset model: k counts back from the end date (k = end day); a loan
 * entered at offset e shows dpd = e - k + 1 while present. Presence bands:
 *   entry band [e .. l]  (l = lastPresentDayOffset, 0 = never cured before end)
 *   stay re-entry band [eR .. 0] (reentryDayOffset r, dpd 1 at k = r)
 * Loans whose entry day lands on a Sunday surface in the next file at k = e-1
 * with dpd 2 (the importer skips Sundays) — only the brief's LN-10293/LN-11930
 * plus dice entries that hit Sundays do this.
 */
import type { SeedConfig } from './config.js';
import { borrowerNamePool, firmName } from './names.js';
import { int, lognormalClipped, pick, poisson, type Rng } from './rng.js';

export type LoanSegment = 'manufacturer' | 'trader' | 'service';
export type LoanDestiny = 'roll' | 'stay' | 'cure' | 'early' | 'fresh';
export type BranchCode = 'IDR' | 'DWS' | 'UJJ';

export const BRANCH_NAMES: Record<BranchCode, string> = { IDR: 'Indore', DWS: 'Dewas', UJJ: 'Ujjain' };

export interface GeneratedLoan {
  loanId: string;
  borrowerName: string;
  businessName: string | null;
  segment: LoanSegment;
  mobile: string;
  altMobile: string | null;
  address: string;
  pincode: string;
  /** null = whole-pincode generic row; otherwise an exact locality slice. */
  locality: string | null;
  branchCode: BranchCode;
  /** 'ratlam' marks the Ujjain-branch officer serving Ratlam (A3). */
  subBranch: 'indore' | 'dewas' | 'ujjain' | 'ratlam';
  product: string;
  outstandingRupees: number;
  emiRupees: number;
  bounceCount: number;
  vintageMonths: number;
  destiny: LoanDestiny;
  /** e: entry offset, dpd 1 on that day; end dpd = e + 1. */
  entryDayOffset: number;
  /** l: last day of the pre-cure band; 0 = never cured before the end. */
  lastPresentDayOffset: number;
  /** r: re-entry offset (dpd 1 again); -1 = never re-entered. */
  reentryDayOffset: number;
}

export interface LoanUniverse {
  seed: number;
  loans: GeneratedLoan[];
}

export const BRIEF_LOAN_IDS: readonly string[] = ['LN-10293', 'LN-10871', 'LN-11930'];
const BRIEF_ID_SET = new Set<string>(BRIEF_LOAN_IDS);

interface BriefSpec {
  loanId: string;
  briefEndDpd: number;
  borrowerName: string;
  businessName: string | null;
  rupees: number;
  branchCode: BranchCode;
  subBranch: GeneratedLoan['subBranch'];
  pincode: string;
  locality: string | null;
  segment: LoanSegment;
}

/** The brief's three sample rows carry exact POS and DPD pins; business name
 *  of LN-10871 is NULL because that is how data/sample_overdue.csv ships it. */
function briefSpecs(config: SeedConfig): BriefSpec[] {
  return [
    {
      loanId: 'LN-10293',
      briefEndDpd: 12,
      borrowerName: 'Ramesh Sharma',
      businessName: 'Sharma Kirana',
      rupees: 640_000,
      branchCode: 'UJJ',
      subBranch: 'ratlam',
      pincode: config.territory.ratlam_pincode,
      // The brief's own locality label; the planner falls through to the
      // 457001 generic row -> Imran Qureshi (verified in planAssignment).
      locality: 'Ratlam',
      segment: 'trader'
    },
    {
      loanId: 'LN-10871',
      briefEndDpd: 27,
      borrowerName: 'Sunita Bai',
      businessName: null,
      rupees: 310_000,
      branchCode: 'UJJ',
      subBranch: 'ujjain',
      // Branch UJJ with an Indore pincode shard: no Ujjain territory row
      // matches and every prefix tier misses -> genuinely queues (A24).
      pincode: config.territory.indore_pincode_main,
      locality: config.territory.indore_shared_locality,
      segment: 'service'
    },
    {
      loanId: 'LN-11930',
      briefEndDpd: 19,
      borrowerName: 'Abdul Khan',
      businessName: 'Khan Traders',
      rupees: 220_000,
      branchCode: 'DWS',
      subBranch: 'dewas',
      pincode: config.territory.dewas_pincode,
      locality: config.territory.dewas_localities[0] ?? null,
      segment: 'trader'
    }
  ] satisfies BriefSpec[];
}

/** Public definition list (used by tests and the later summary step). */
export function briefLoanDefinitions(
  universe: { loans: readonly GeneratedLoan[] },
  config: SeedConfig
): { loanId: string; briefEndDpd: number; subBranch: GeneratedLoan['subBranch'] }[] {
  return briefSpecs(config).map((spec) => {
    const loan = universe.loans.find((l) => l.loanId === spec.loanId);
    if (!loan) {
      throw new Error(`brief loan ${spec.loanId} is missing from the universe`);
    }
    if (loan.outstandingRupees !== spec.rupees) {
      throw new Error(`brief loan ${spec.loanId} POS drifted from its pin`);
    }
    return { loanId: spec.loanId, briefEndDpd: spec.briefEndDpd, subBranch: spec.subBranch };
  });
}

/** Largest-remainder integer split of `total` over `shares` (sum 1). */
export function allocateShareCounts(total: number, shares: readonly number[]): number[] {
  const exact = shares.map((share) => share * total);
  const counts = exact.map(Math.floor);
  let left = total - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ remainder: value - Math.floor(value), index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let cursor = 0;
  while (left > 0) {
    const slot = order[cursor % order.length]!;
    counts[slot.index]! += 1;
    left -= 1;
    cursor += 1;
  }
  return counts;
}

export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

const ADDRESS_PLACES = [
  'Rajwada', 'Palace', 'Krishi Upaj Mandi', 'Bus Stand', 'Sarafa Bazaar', 'Siyaganj',
  'Bijalpur', 'Rau', 'Sanwer', 'Mhow Naka', 'Bhawarkua', 'Freeganj', 'Nanakheda',
  'Topkhana', 'Gwaltoli', 'Mahakal'
] as const;

const ADDRESS_STREETS = ['Marg', 'Road', 'Chowk', 'Gali', 'Path', 'Market'] as const;

export function buildLoanUniverse(rng: Rng, config: SeedConfig, seed: number): LoanUniverse {
  const loansConfig = config.loans;
  const historyConfig = config.history;
  const rolls = historyConfig.roll_count_indore + historyConfig.roll_count_ujjain_branch + historyConfig.roll_count_dewas;
  const stays = historyConfig.stayed_count_indore + historyConfig.stayed_count_ujjain_branch + historyConfig.stayed_count_dewas;
  const cohortN = historyConfig.cohort_count_indore + historyConfig.cohort_count_ujjain_branch + historyConfig.cohort_count_dewas;
  const cures = cohortN - rolls - stays;
  const endActive = loansConfig.per_branch_indore + loansConfig.per_branch_ujjain_branch + loansConfig.per_branch_dewas;
  const universeSize = endActive + cures;

  const curedByBranch: Record<BranchCode, number> = {
    IDR: historyConfig.cohort_count_indore - historyConfig.roll_count_indore - historyConfig.stayed_count_indore,
    UJJ: historyConfig.cohort_count_ujjain_branch - historyConfig.roll_count_ujjain_branch - historyConfig.stayed_count_ujjain_branch,
    DWS: historyConfig.cohort_count_dewas - historyConfig.roll_count_dewas - historyConfig.stayed_count_dewas
  };
  const briefsByBranch: Record<BranchCode, number> = { IDR: 0, UJJ: 2, DWS: 1 };

  // ---- names, ids ----
  const borrowerNames = borrowerNamePool(rng, universeSize);
  const idBase = 11000 + (seed % 7); // stays clear of LN-10293/10871/11930
  const generatedIds = shuffled(
    rng,
    Array.from({ length: universeSize - BRIEF_LOAN_IDS.length }, (_, index) => `LN-${idBase + index}`)
  );

  const loans: GeneratedLoan[] = [];
  let nameCursor = 0;
  let idCursor = 0;

  for (const brief of briefSpecs(config)) {
    loans.push({
      loanId: brief.loanId,
      borrowerName: brief.borrowerName,
      businessName: brief.businessName,
      segment: brief.segment,
      mobile: phone(rng),
      altMobile: phone(rng),
      address: `${pick(rng, ADDRESS_PLACES)} ${pick(rng, ADDRESS_STREETS)}`,
      pincode: brief.pincode,
      locality: brief.locality,
      branchCode: brief.branchCode,
      subBranch: brief.subBranch,
      product: productFor(config, brief.segment),
      outstandingRupees: brief.rupees,
      emiRupees: Math.round(brief.rupees / 12),
      bounceCount: poisson(rng, loansConfig.bounce_poisson_lambda, loansConfig.bounce_cap),
      vintageMonths: int(rng, loansConfig.vintage_min_months, loansConfig.vintage_max_months),
      destiny: 'fresh',
      entryDayOffset: brief.briefEndDpd - 1,
      lastPresentDayOffset: 0,
      reentryDayOffset: -1
    });
  }

  const byBranch: Record<BranchCode, GeneratedLoan[]> = { IDR: [], DWS: [], UJJ: [] };
  for (const code of ['IDR', 'DWS', 'UJJ'] as const) {
    const size = universeByCode(config, code) + curedByBranch[code] - briefsByBranch[code];
    for (let i = 0; i < size; i += 1) {
      const loanId = generatedIds[idCursor]!;
      idCursor += 1;
      byBranch[code].push({
        loanId,
        borrowerName: borrowerNames[nameCursor]!,
        businessName: null,
        segment: 'trader',
        mobile: phone(rng),
        altMobile: phone(rng),
        address: '',
        pincode: '',
        locality: null,
        branchCode: code,
        subBranch: code === 'IDR' ? 'indore' : code === 'DWS' ? 'dewas' : 'ujjain',
        product: '',
        outstandingRupees: 0,
        emiRupees: 0,
        bounceCount: 0,
        vintageMonths: 0,
        destiny: 'fresh',
        entryDayOffset: 0,
        lastPresentDayOffset: 0,
        reentryDayOffset: -1
      });
      nameCursor += 1;
    }
  }

  for (const code of ['IDR', 'DWS', 'UJJ'] as const) {
    loans.push(...byBranch[code]);
  }

  // ---- destiny allocation: counts pinned to config, members by dice ----
  for (const code of ['IDR', 'DWS', 'UJJ'] as const) {
    const slice = byBranch[code];
    const order = shuffled(rng, slice.map((_, index) => index));
    const counts: Record<LoanDestiny, number> = {
      roll: rollsByBranch(config, code),
      stay: staysByBranch(config, code),
      cure: curedByBranch[code],
      early: earliesByBranch(config, code),
      fresh: freshByBranch(config, code, briefsByBranch[code])
    };
    let cursor = 0;
    for (const destiny of ['roll', 'stay', 'cure', 'early', 'fresh'] as const) {
      for (let i = 0; i < counts[destiny]; i += 1) {
        const loan = slice[order[cursor]!]!;
        loan.destiny = destiny;
        assignOffsetDraw(rng, loan, destiny);
        cursor += 1;
      }
    }
  }

  // Pin three early loans to e = 89 so the first file day is never empty
  // (the importer aborts an empty first file).
  const earlyPins = loans.filter((loan) => loan.destiny === 'early');
  if (earlyPins.length < 3) {
    throw new Error('loans: need at least three early loans to pin to the first day');
  }
  for (const loan of earlyPins.slice(0, 3)) {
    loan.entryDayOffset = 89;
  }

  // ---- ujjain city/ratlam sub-branch quota (end-active exact) ----
  applySubBranches(rng, config, loans);
  // ---- territory: pincodes/localities per branch (counts, not rates) ----
  applyTerritoryShapes(rng, config, loans);

  // ---- tickets and contact data (deterministic order over the full array) ----
  for (const loan of loans) {
    if (BRIEF_ID_SET.has(loan.loanId)) {
      continue;
    }
    const rupees = Math.round(lognormalClipped(
      rng,
      loansConfig.ticket_median_rupees,
      loansConfig.ticket_ln_sigma,
      loansConfig.ticket_min_rupees,
      loansConfig.ticket_max_rupees
    ));
    loan.outstandingRupees = rupees;
    loan.emiRupees = Math.round(rupees / 12);
    loan.bounceCount = poisson(rng, loansConfig.bounce_poisson_lambda, loansConfig.bounce_cap);
    loan.vintageMonths = int(rng, loansConfig.vintage_min_months, loansConfig.vintage_max_months);
    loan.address = `${pick(rng, ADDRESS_PLACES)} ${pick(rng, ADDRESS_STREETS)}`;
  }

  // ---- segments: exact floor split (briefs pinned) ----
  const nonBriefs = loans.filter((loan) => !BRIEF_ID_SET.has(loan.loanId));
  const briefMakers = briefSpecs(config).filter((brief) => brief.segment === 'manufacturer').length;
  const briefTraders = briefSpecs(config).filter((brief) => brief.segment === 'trader').length;
  const briefServices = briefSpecs(config).filter((brief) => brief.segment === 'service').length;
  const totalMaker = Math.floor(config.loans.segment_weights[0]! * loans.length);
  const totalTrader = Math.floor(config.loans.segment_weights[1]! * loans.length);
  const totalService = loans.length - totalMaker - totalTrader;
  const orderedForSegments = shuffled(rng, nonBriefs);
  let segCursor = 0;
  for (let i = 0; i < totalMaker - briefMakers; i += 1) {
    orderedForSegments[segCursor++]!.segment = 'manufacturer';
  }
  for (let i = 0; i < totalTrader - briefTraders; i += 1) {
    orderedForSegments[segCursor++]!.segment = 'trader';
  }
  for (let i = 0; i < totalService - briefServices; i += 1) {
    orderedForSegments[segCursor++]!.segment = 'service';
  }
  for (const loan of orderedForSegments) {
    loan.product = productFor(config, loan.segment);
    if (BRIEF_ID_SET.has(loan.loanId)) {
      continue; // brief rows keep their pinned business names
    }
    loan.businessName = firmName(rng, loan.segment);
  }

  // ---- deliberate defects: exact end-active counts, disjoint slices ----
  applyDefects(rng, config, loans);

  return { seed, loans };
}

function universeByCode(config: SeedConfig, code: BranchCode): number {
  const loansConfig = config.loans;
  return code === 'IDR'
    ? loansConfig.per_branch_indore
    : code === 'DWS'
      ? loansConfig.per_branch_dewas
      : loansConfig.per_branch_ujjain_branch;
}

function rollsByBranch(config: SeedConfig, code: BranchCode): number {
  return code === 'IDR'
    ? config.history.roll_count_indore
    : code === 'DWS'
      ? config.history.roll_count_dewas
      : config.history.roll_count_ujjain_branch;
}

function staysByBranch(config: SeedConfig, code: BranchCode): number {
  return code === 'IDR'
    ? config.history.stayed_count_indore
    : code === 'DWS'
      ? config.history.stayed_count_dewas
      : config.history.stayed_count_ujjain_branch;
}

function earliesByBranch(config: SeedConfig, code: BranchCode): number {
  return code === 'IDR'
    ? config.history.early_count_indore
    : code === 'DWS'
      ? config.history.early_count_dewas
      : config.history.early_count_ujjain_branch;
}

function freshByBranch(config: SeedConfig, code: BranchCode, briefFreshes: number): number {
  const endActive = universeByCode(config, code);
  const nonEnd = rollsByBranch(config, code) + staysByBranch(config, code) + earliesByBranch(config, code);
  return endActive - nonEnd - briefFreshes;
}

function assignOffsetDraw(rng: Rng, loan: GeneratedLoan, destiny: LoanDestiny): void {
  switch (destiny) {
    case 'roll':
    case 'cure':
      loan.entryDayOffset = int(rng, 30, 59);
      loan.reentryDayOffset = -1;
      loan.lastPresentDayOffset = destiny === 'roll' ? 0 : int(rng, 1, Math.min(29, loan.entryDayOffset - 1));
      break;
    case 'stay': {
      loan.entryDayOffset = int(rng, 30, 59);
      loan.lastPresentDayOffset = int(rng, 7, Math.min(29, loan.entryDayOffset - 1));
      const wait = int(rng, 7, Math.min(20, loan.lastPresentDayOffset));
      loan.reentryDayOffset = loan.lastPresentDayOffset - wait; // >= 0, gap 7-20 days
      break;
    }
    case 'early':
      loan.entryDayOffset = int(rng, 60, 89);
      loan.lastPresentDayOffset = 0;
      loan.reentryDayOffset = -1;
      break;
    case 'fresh':
      loan.entryDayOffset = int(rng, 1, 29);
      loan.lastPresentDayOffset = 0;
      loan.reentryDayOffset = -1;
      break;
  }
}

function phone(rng: Rng): string {
  let digits = pick(rng, ['6', '7', '8', '9'])!;
  for (let i = 0; i < 9; i += 1) {
    digits += String(int(rng, 0, 9));
  }
  return digits;
}

function productFor(config: SeedConfig, segment: LoanSegment): string {
  return segment === 'manufacturer'
    ? config.loans.product_manufacturer
    : segment === 'trader'
      ? config.loans.product_trader
      : config.loans.product_service;
}

interface PinShape {
  pincode: string;
  locality: string | null;
}

/** Indore ujjain/dewas/indore spreads as exact share allocations; Dewas is
 *  pure locality split (no generic row). Ratlam is all 457001. */
function indoreShapes(config: SeedConfig): PinShape[] {
  return [
    { pincode: config.territory.indore_pincode_main, locality: null },
    { pincode: config.territory.indore_pincode_main, locality: config.territory.indore_shared_locality },
    { pincode: config.territory.indore_pincode_east, locality: null },
    { pincode: config.territory.indore_pincode_south, locality: null }
  ];
}

function applyTerritoryShapes(rng: Rng, config: SeedConfig, loans: GeneratedLoan[]): void {
  const indoreShapes_ = indoreShapes(config);
  const indoreShares = [
    config.territory.indore_main_generic_share,
    config.territory.indore_main_locality_share,
    config.territory.indore_east_share,
    config.territory.indore_south_share
  ];
  for (const code of ['IDR', 'DWS', 'UJJ'] as const) {
    const slice = loans.filter((loan) => loan.branchCode === code && !BRIEF_ID_SET.has(loan.loanId));
    const order = shuffled(rng, slice.map((_, index) => index));
    if (code === 'IDR') {
      const counts = allocateShareCounts(slice.length, indoreShares);
      let cursor = 0;
      for (let i = 0; i < counts.length; i += 1) {
        for (let j = 0; j < counts[i]!; j += 1) {
          const loan = slice[order[cursor++]!]!;
          loan.pincode = indoreShapes_[i]!.pincode;
          loan.locality = indoreShapes_[i]!.locality;
        }
      }
      continue;
    }
    if (code === 'DWS') {
      const counts = allocateShareCounts(slice.length, config.territory.dewas_locality_split);
      let cursor = 0;
      for (let i = 0; i < counts.length; i += 1) {
        for (let j = 0; j < counts[i]!; j += 1) {
          const loan = slice[order[cursor++]!]!;
          loan.pincode = config.territory.dewas_pincode;
          loan.locality = config.territory.dewas_localities[i] ?? null;
        }
      }
      continue;
    }
    // Ujjain branch: city loans split Freeganj/generic, ratlam loans 457001.
    const city = slice.filter((loan) => loan.subBranch === 'ujjain');
    const cityOrder = shuffled(rng, city.map((_, index) => index));
    const cityCounts = allocateShareCounts(city.length, [config.territory.ujjain_city_locality_share, 1 - config.territory.ujjain_city_locality_share]);
    let cityCursor = 0;
    for (let i = 0; i < cityCounts.length; i += 1) {
      for (let j = 0; j < cityCounts[i]!; j += 1) {
        const loan = city[cityOrder[cityCursor++]!]!;
        loan.pincode = config.territory.ujjain_pincode;
        loan.locality = i === 0 ? config.territory.ujjain_localities[0] ?? null : null;
      }
    }
    for (const loan of slice.filter((row) => row.subBranch === 'ratlam')) {
      loan.pincode = config.territory.ratlam_pincode;
      loan.locality = null; // generic row -> Imran Qureshi
    }
  }
}

function applySubBranches(rng: Rng, config: SeedConfig, loans: GeneratedLoan[]): void {
  const ujjain = loans.filter((loan) => loan.branchCode === 'UJJ' && !BRIEF_ID_SET.has(loan.loanId));
  const endActive = ujjain.filter((loan) => loan.destiny !== 'cure');
  const briefRatlam = loans.filter(
    (loan) => BRIEF_ID_SET.has(loan.loanId) && loan.branchCode === 'UJJ' && loan.destiny !== 'cure' && loan.subBranch === 'ratlam'
  ).length;
  const order = shuffled(rng, endActive.map((_, index) => index));
  const ratlamQuota = config.loans.per_branch_ratlam - briefRatlam;
  let cursor = 0;
  for (let i = 0; i < ratlamQuota; i += 1) {
    endActive[order[cursor++]!]!.subBranch = 'ratlam';
  }
  // (the rest keep the skeleton default 'ujjain' — no cleanup loop, it would
  //  reset shuffled ratlam slots)
  // Cured loans split by the same city/ratlam shares (not asserted externally).
  const cured = ujjain.filter((loan) => loan.destiny === 'cure');
  const cityShare = config.loans.per_branch_ujjain_city / config.loans.per_branch_ujjain_branch;
  const curedCounts = allocateShareCounts(cured.length, [cityShare, 1 - cityShare]);
  const curedOrder = shuffled(rng, cured.map((_, index) => index));
  for (let i = 0; i < curedCounts[0]!; i += 1) {
    cured[curedOrder[i]!]!.subBranch = 'ujjain';
  }
  for (let i = curedCounts[0]!; i < cured.length; i += 1) {
    cured[curedOrder[i]!]!.subBranch = 'ratlam';
  }
}

/** Exact counts of round(rate x end-active), disjoint slices of one shuffled
 *  list with LN-10871 forced into the missing-business slice and the other
 *  brief loans pushed past every slice window. Cured loans stay clean. */
function applyDefects(rng: Rng, config: SeedConfig, loans: GeneratedLoan[]): void {
  const endActive = loans.filter((loan) => loan.destiny !== 'cure');
  const sliced = shuffled(rng, endActive);
  const briefIndex = sliced.findIndex((loan) => loan.loanId === 'LN-10871');
  if (briefIndex < 0) {
    throw new Error('loans: LN-10871 is missing from the defect population');
  }
  if (briefIndex !== 0) {
    const tmp = sliced[0]!;
    sliced[0] = sliced[briefIndex]!;
    sliced[briefIndex] = tmp;
  }
  const businessCount = Math.round(config.defects.missing_business_name_rate * endActive.length);
  const altCount = Math.round(config.defects.missing_alt_mobile_rate * endActive.length);
  const pinCount = Math.round(config.defects.unmapped_pincode_rate * endActive.length);
  const windowEnd = businessCount + altCount + pinCount;
  for (let i = 1; i < windowEnd; i += 1) {
    if (BRIEF_ID_SET.has(sliced[i]!.loanId)) {
      let j = sliced.length - 1;
      while (j >= windowEnd && BRIEF_ID_SET.has(sliced[j]!.loanId)) {
        j -= 1;
      }
      const tmp = sliced[i]!;
      sliced[i] = sliced[j]!;
      sliced[j] = tmp;
    }
  }
  for (let i = 0; i < businessCount; i += 1) {
    sliced[i]!.businessName = null;
  }
  for (let i = businessCount; i < businessCount + altCount; i += 1) {
    sliced[i]!.altMobile = null;
  }
  for (let i = businessCount + altCount; i < windowEnd; i += 1) {
    const loan = sliced[i]!;
    loan.pincode = config.territory.unmapped_defect_pincode;
    loan.locality = null;
  }
}
