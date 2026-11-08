/**
 * SPEC 8 priority scorecard, pure and test-first. A transparent logistic
 * scorecard centred on the brief's 22% roll rate — NOT machine learning
 * (the weights are expert priors, labelled as assumptions; the documented
 * path to a fitted model is the back-test).
 *
 * Model: z_j = clip((x_j - mu_j)/sd_j, -3, 3) on the continuous features
 * (log1p already applied by the caller where the feature demands it), and
 * one-hot terms for the last contact outcome group with NO CONTACT as the
 * reference (a loan never touched contributes zero from that family):
 *
 *   logit(p_roll) = logit(0.22) + sum(beta_j * clip(z_j)) + sum(beta_g * x_g)
 *   score = round(100 * p_roll);  High >= 40, Medium 20-39, Low < 20.
 *
 * Kept rate shrunk: (kept + 2) / (made + 3) — a Beta(2,1)-flavoured prior
 * so a loan with no promise history does not get a perfect or zero rate.
 *
 * Reasons are the per-feature model terms: contribution_j = beta_j *
 * clip(z_j) — the linear SHAP value on the standardised feature (the
 * sd-scaled form of beta*(x - mean); the mean is absorbed by z). Because
 * the model is linear in these terms, base + sum(contributions) = logit
 * exactly (tested to 1e-9). The one-hot contribution is beta_g * x_g with
 * the none-reference at zero. Only positive contributions become reasons,
 * sorted descending with the fixed feature-order tie-break, top 3.
 *
 * Missing features impute the portfolio mean (z = 0, contribution 0) and
 * the result flags them as limited data — shown, never hidden.
 */
import weightsJson from './weights.json';

export interface Weights {
  modelVersion: string;
  centerRate: number;
  betas: {
    dpd: number;
    bounces: number;
    broken90: number;
    keptRate: number;
    daysSinceContact: number;
    overdueEmiMultiples: number;
    logOutstanding: number;
    vintageMonths: number;
  };
  outcomeGroupBetas: Record<OutcomeGroup, number>;
  caps: { bounces: number; broken90: number };
  keptRateShrinkage: { addedKept: number; addedMade: number };
  featureOrder: string[];
  lowLaneMaxPRoll: number;
}

export const weights: Weights = weightsJson as Weights;

export type OutcomeGroup = 'unreachable' | 'refused' | 'promised' | 'part_paid';
export type Band = 'high' | 'medium' | 'low';

export interface RawFeatures {
  dpd: number | null;
  bounces: number | null;
  broken90: number | null;
  keptKept: number | null;
  keptMade: number | null;
  lastOutcomeGroup: OutcomeGroup | null;
  daysSinceContact: number | null;
  overdue: number | null;
  emi: number | null;
  outstanding: number | null;
  vintageMonths: number | null;
}

export interface StandardisationParams {
  modelVersion: string;
  features: Record<string, { mean: number; sd: number }>;
  outcomeShares: Record<OutcomeGroup, number>;
}

export interface ReasonContribution {
  feature: string;
  contribution: number;
  /** Raw evidence for the templated phrase (e.g. { count: 2 }, { days: 9 }). */
  evidence: Record<string, number | string>;
}

export interface ScoredLoan {
  logit: number;
  /** The constant the contributions sum against: logit(centerRate). */
  base: number;
  pRoll: number;
  score: number;
  band: Band;
  contributions: ReasonContribution[];
  topReasons: ReasonContribution[];
  /** Feature keys imputed from the portfolio mean. */
  limitedData: string[];
}

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clip3(z: number): number {
  return Math.max(-3, Math.min(3, z));
}

/** (kept + 2) / (made + 3), the shrunk promise-kept rate. */
export function keptRateShrunk(kept: number, made: number, w: Weights): number {
  return (kept + w.keptRateShrinkage.addedKept) / (made + w.keptRateShrinkage.addedMade);
}

export function bandFor(score: number): Band {
  if (score >= 40) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

function capValue(value: number, cap: number): number {
  return Math.min(value, cap);
}

/** Continuous feature table: raw value -> standardised + clipped z. */
function featureTerms(
  features: RawFeatures,
  params: StandardisationParams,
  w: Weights
): { contributions: ReasonContribution[]; limitedData: string[]; zSum: number } {
  const keptRate = keptRateShrunk(features.keptKept ?? 0, features.keptMade ?? 0, w);
  const emi = features.emi && features.emi > 0 ? features.emi : null;
  const overdueEmiMultiples = emi !== null && features.overdue !== null ? features.overdue / emi : null;
  const logOutstanding = features.outstanding !== null ? Math.log1p(features.outstanding) : null;
  const bounces = features.bounces !== null ? capValue(features.bounces, w.caps.bounces) : null;
  const broken90 = features.broken90 !== null ? capValue(features.broken90, w.caps.broken90) : null;

  const continuous: { feature: string; value: number | null; evidence: Record<string, number | string> }[] = [
    { feature: 'dpd', value: features.dpd, evidence: { days: features.dpd ?? 0 } },
    { feature: 'bounces', value: bounces, evidence: { count: bounces ?? 0 } },
    { feature: 'broken90', value: broken90, evidence: { count: broken90 ?? 0 } },
    { feature: 'keptRate', value: keptRate, evidence: { kept: features.keptKept ?? 0, made: features.keptMade ?? 0 } },
    { feature: 'daysSinceContact', value: features.daysSinceContact, evidence: { days: features.daysSinceContact ?? 0 } },
    { feature: 'overdueEmiMultiples', value: overdueEmiMultiples, evidence: { multiples: Math.round((overdueEmiMultiples ?? 0) * 10) / 10 } },
    { feature: 'logOutstanding', value: logOutstanding, evidence: { rupees: features.outstanding ?? 0 } },
    { feature: 'vintageMonths', value: features.vintageMonths, evidence: { months: features.vintageMonths ?? 0 } }
  ];

  const contributions: ReasonContribution[] = [];
  const limitedData: string[] = [];
  let zSum = 0;
  for (const entry of continuous) {
    const stats = params.features[entry.feature];
    if (!stats) {
      throw new Error(`scoring: no standardisation params for feature ${entry.feature}`);
    }
    if (entry.value === null || !Number.isFinite(entry.value)) {
      // Portfolio-mean imputation: z = 0, contribution 0, flagged.
      limitedData.push(entry.feature);
      continue;
    }
    const z = clip3((entry.value - stats.mean) / (stats.sd || 1));
    const beta = (w.betas as Record<string, number>)[entry.feature];
    if (beta === undefined) {
      throw new Error(`scoring: no beta for feature ${entry.feature}`);
    }
    if (z !== 0) {
      contributions.push({ feature: entry.feature, contribution: beta * z, evidence: entry.evidence });
    }
    zSum += beta * z;
  }
  return { contributions, limitedData, zSum };
}

export function scoreLoan(input: { features: RawFeatures; params: StandardisationParams }, w: Weights = weights): ScoredLoan {
  const { features, params } = input;
  if (params.modelVersion !== w.modelVersion) {
    throw new Error(`scoring: params model ${params.modelVersion} does not match weights model ${w.modelVersion}`);
  }
  const { contributions, limitedData, zSum } = featureTerms(features, params, w);

  let oneHotSum = 0;
  if (features.lastOutcomeGroup !== null) {
    const beta = w.outcomeGroupBetas[features.lastOutcomeGroup];
    if (beta === undefined) {
      throw new Error(`scoring: no beta for outcome group ${features.lastOutcomeGroup}`);
    }
    oneHotSum = beta;
    contributions.push({ feature: 'lastOutcomeGroup', contribution: beta, evidence: { group: features.lastOutcomeGroup } });
  }

  const base = logit(w.centerRate);
  const logitValue = base + zSum + oneHotSum;
  const pRoll = sigmoid(logitValue);
  const score = Math.round(100 * pRoll);

  const order = (a: ReasonContribution, b: ReasonContribution): number =>
    b.contribution - a.contribution || w.featureOrder.indexOf(a.feature) - w.featureOrder.indexOf(b.feature);
  const topReasons = [...contributions].sort(order).slice(0, 3);

  return { logit: logitValue, base, pRoll, score, band: bandFor(score), contributions, topReasons, limitedData };
}

/** SPEC 8 low lane: p_roll < 0.10 AND no broken promise. */
export function lowLaneFor(entry: { pRoll: number; hasBrokenPromise: boolean }, w: Weights = weights): boolean {
  return entry.pRoll < w.lowLaneMaxPRoll && !entry.hasBrokenPromise;
}

export interface WorklistEntry {
  loanId: string;
  pRoll: number;
  score: number;
  band: Band;
  rupeesAtRisk: number;
  hasBrokenPromise: boolean;
  duePromise: boolean;
}

/** Promise-due-today pins first (by rupees at risk), then the actionable
 *  book by rupees at risk, then the low lane (nudge only) at the bottom. */
export function worklistOrder<T extends WorklistEntry>(entries: readonly T[], w: Weights = weights): T[] {
  const byRisk = (a: T, b: T): number => b.rupeesAtRisk - a.rupeesAtRisk || a.loanId.localeCompare(b.loanId);
  const pinned = entries.filter((entry) => entry.duePromise).sort(byRisk);
  const lane = entries.filter((entry) => !entry.duePromise && lowLaneFor(entry, w)).sort(byRisk);
  const rest = entries.filter((entry) => !entry.duePromise && !lowLaneFor(entry, w)).sort(byRisk);
  return [...pinned, ...rest, ...lane];
}

/** Fallback order when scoring throws: broken promises, then DPD, then
 *  overdue amount (SPEC 8 "standard order" — never a fake score). */
export function fallbackComparator(
  a: { broken: number; dpd: number; overdue: number },
  b: { broken: number; dpd: number; overdue: number }
): number {
  return b.broken - a.broken || b.dpd - a.dpd || b.overdue - a.overdue;
}
