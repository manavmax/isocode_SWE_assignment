/**
 * Back-test (SPEC 8, prompt 12 item 7): score every loan in 1-30 DPD at the
 * t0 snapshot using ONLY data available at t0, and compare against the
 * outcome 30 days later (rolled to 31+ or not). Time-based split — no
 * random holdout. Writes docs/backtest.md.
 *
 * t0 = the snapshot t0_days_before_end days before the latest batch (the
 * seed's cohort day). Features at t0: DPD and outstanding from the t0
 * snapshot, promise and contact history STRICTLY before t0, static loan
 * attributes (bounce_count_12m, vintage_months, emi) as they stand. The
 * overdue amount AT t0 is not in the snapshot — the feature imputes the
 * portfolio mean (limited data), stated plainly in the report.
 *
 * The standardisation params are the committed ones (fitted at the end
 * date): the means/SDs are portfolio constants, not outcome-derived — noted
 * in the report. The weights are the SPEC's expert priors, NOT tuned to
 * improve this number.
 *
 * The data is synthetic: this proves the pipeline works, not real-world
 * accuracy. The honest value-add is the delta over the DPD baseline.
 */
import { closePool, getPool } from '../src/server/db.js';
import { scoreLoan, weights, type RawFeatures, type WorklistEntry } from '../src/shared/scoring/scorecard.js';
import { loadParams } from '../src/server/scoring/runScoring.js';
import { loadSeedConfigFile } from './seed/config.js';

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const config = loadSeedConfigFile(new URL('../data/seed_config.yaml', import.meta.url).pathname);
const pool = getPool();
const batch = (await pool.query(`SELECT max(as_of)::text AS latest FROM import_batch`)).rows[0] as { latest: string | null };
failUnless(batch.latest, 'no import batches — run the seed first');
const end = (batch.latest as string).slice(0, 10);
const t0 = new Date(Date.parse(`${end}T00:00:00Z`) - config.history.cohort_days_before_end * 86_400_000)
  .toISOString()
  .slice(0, 10);
const t0End = new Date(Date.parse(`${end}T00:00:00Z`)).toISOString().slice(0, 10);

const params = loadParams();

// Cohort: 1-30 DPD at t0, outcome from the end snapshot.
const rows = (
  await pool.query(
    `
    WITH cohort AS (
      SELECT s.loan_id, s.dpd, s.outstanding, l.bounce_count_12m, l.vintage_months, l.emi_amount
      FROM loan_snapshot s JOIN loan l ON l.loan_id = s.loan_id
      WHERE s.as_of = DATE $1 AND s.dpd BETWEEN 1 AND 30
    ), end_state AS (
      SELECT loan_id, dpd FROM loan_snapshot WHERE as_of = DATE $2
    )
    SELECT c.loan_id, c.dpd, c.outstanding, c.bounce_count_12m, c.vintage_months, c.emi_amount,
           (e.loan_id IS NOT NULL AND e.dpd >= 31) AS rolled,
           (SELECT count(*) FROM promise p WHERE p.loan_id = c.loan_id
              AND p.status IN ('broken','broken_part') AND p.resolved_at < DATE $1)::int AS broken90,
           (SELECT count(*) FROM promise p WHERE p.loan_id = c.loan_id AND p.status = 'kept'
              AND p.created_at < DATE $1)::int AS kept,
           (SELECT count(*) FROM promise p WHERE p.loan_id = c.loan_id AND p.status IN ('kept','broken','broken_part')
              AND p.created_at < DATE $1)::int AS made,
           (SELECT ce.outcome FROM contact_event ce WHERE ce.loan_id = c.loan_id
              AND ce.kind IN ('CALL','VISIT','MESSAGE') AND ce.attempted_at_ist < DATE $1
              ORDER BY ce.attempted_at_ist DESC LIMIT 1) AS last_outcome,
           (SELECT max((ce.attempted_at_ist AT TIME ZONE 'Asia/Kolkata')::date)::text FROM contact_event ce
              WHERE ce.loan_id = c.loan_id AND ce.kind IN ('CALL','VISIT','MESSAGE')
              AND ce.attempted_at_ist < DATE $1) AS last_touch_date,
           EXISTS (SELECT 1 FROM promise p WHERE p.loan_id = c.loan_id AND p.status IN ('broken','broken_part')) AS has_broken
    FROM cohort c LEFT JOIN end_state e ON e.loan_id = c.loan_id
    ORDER BY c.loan_id
  `,
    [t0, t0End]
  )
).rows as Record<string, unknown>[];

failUnless(rows.length >= 30, `cohort too small at t0 ${t0}: ${rows.length} loans`);

const GROUP_FOR_OUTCOME: Record<string, 'unreachable' | 'refused' | 'promised' | 'part_paid'> = {
  not_reachable: 'unreachable',
  wrong_number: 'unreachable',
  refused: 'refused',
  dispute: 'refused',
  promise_to_pay: 'promised',
  paid: 'part_paid'
};

interface BacktestLoan {
  loanId: string;
  rolled: boolean;
  dpd: number;
  outstanding: number;
  brokenCount: number;
  entry: WorklistEntry;
  /** The model's predicted probability, for the decile calibration. */
  pRoll: number;
}

const loans: BacktestLoan[] = [];
let limitedCount = 0;
for (const row of rows) {
  const lastTouch = row.last_touch_date ? String(row.last_touch_date) : null;
  const daysSince = lastTouch
    ? Math.max(0, Math.round((Date.parse(`${t0}T00:00:00Z`) - Date.parse(`${lastTouch}T00:00:00Z`)) / 86_400_000))
    : null;
  const features: RawFeatures = {
    dpd: Number(row.dpd),
    bounces: Number(row.bounce_count_12m),
    broken90: Number(row.broken90),
    keptKept: Number(row.kept),
    keptMade: Number(row.made),
    lastOutcomeGroup: row.last_outcome ? (GROUP_FOR_OUTCOME[String(row.last_outcome)] ?? null) : null,
    daysSinceContact: daysSince,
    // The t0 snapshot has no overdue column: imputed mean, flagged limited.
    overdue: null,
    emi: row.emi_amount === null ? null : Number(row.emi_amount),
    outstanding: Number(row.outstanding),
    vintageMonths: Number(row.vintage_months)
  };
  const result = scoreLoan({ features, params });
  if (result.limitedData.length > 0) {
    limitedCount += 1;
  }
  loans.push({
    loanId: String(row.loan_id),
    rolled: row.rolled === true,
    dpd: Number(row.dpd),
    outstanding: Number(row.outstanding),
    brokenCount: Number(row.broken90),
    pRoll: result.pRoll,
    entry: {
      loanId: String(row.loan_id),
      pRoll: result.pRoll,
      score: result.score,
      band: result.band,
      rupeesAtRisk: Math.round(result.pRoll * Number(row.outstanding)),
      hasBrokenPromise: row.has_broken === true,
      duePromise: false
    }
  });
}

function auc(pairs: { p: number; y: boolean }[]): number {
  // Rank-based (Mann-Whitney) with mid-ranks for ties.
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  const n = sorted.length;
  let rankSumPos = 0;
  let positives = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1]!.p === sorted[i]!.p) {
      j += 1;
    }
    const midRank = (i + j + 2) / 2; // 1-based average rank
    for (let k = i; k <= j; k += 1) {
      if (sorted[k]!.y) {
        rankSumPos += midRank;
        positives += 1;
      }
    }
    i = j + 1;
  }
  const negatives = n - positives;
  return positives === 0 || negatives === 0 ? Number.NaN : (rankSumPos - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function brier(pairs: { p: number; y: boolean }[]): number {
  return pairs.reduce((acc, pair) => acc + (pair.p - (pair.y ? 1 : 0)) ** 2, 0) / pairs.length;
}

function ks(pairs: { p: number; y: boolean }[]): number {
  const positives = pairs.filter((pair) => pair.y).map((pair) => pair.p).sort((a, b) => a - b);
  const negatives = pairs.filter((pair) => !pair.y).map((pair) => pair.p).sort((a, b) => a - b);
  const all = [...new Set(pairs.map((pair) => pair.p))].sort((a, b) => a - b);
  let maxGap = 0;
  for (const threshold of all) {
    const cdfPos = positives.filter((p) => p <= threshold).length / Math.max(1, positives.length);
    const cdfNeg = negatives.filter((p) => p <= threshold).length / Math.max(1, negatives.length);
    maxGap = Math.max(maxGap, Math.abs(cdfPos - cdfNeg));
  }
  return maxGap;
}

function decileTable(rowsIn: { p: number; y: boolean }[]): string[] {
  const sorted = [...rowsIn].sort((a, b) => b.p - a.p);
  const n = sorted.length;
  const totalRolls = sorted.filter((r) => r.y).length;
  const lines: string[] = [];
  lines.push('| decile | n | mean predicted | actual roll rate | lift | cumulative rolls captured |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  let cumulativeRolls = 0;
  for (let d = 0; d < 10; d += 1) {
    const slice = sorted.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10));
    if (slice.length === 0) {
      continue;
    }
    const meanPredicted = slice.reduce((acc, r) => acc + r.p, 0) / slice.length;
    const actual = slice.filter((r) => r.y).length;
    cumulativeRolls += actual;
    const baseRate = totalRolls / n;
    const lift = actual / slice.length / baseRate;
    lines.push(
      `| ${d + 1} | ${slice.length} | ${(meanPredicted * 100).toFixed(1)}% | ` +
        `${((100 * actual) / slice.length).toFixed(1)}% | ${lift.toFixed(2)}x | ` +
        `${((100 * cumulativeRolls) / Math.max(1, totalRolls)).toFixed(1)}% |`
    );
  }
  return lines;
}

function metrics(pairs: { p: number; y: boolean }[]): { auc: number; gini: number; ks: number; brier: number } {
  const a = auc(pairs);
  return { auc: a, gini: 2 * a - 1, ks: ks(pairs), brier: brier(pairs) };
}

// --- the model, scored at t0 ---
const modelPairs = loans.map((loan) => ({ p: loan.pRoll, y: loan.rolled }));
const model = metrics(modelPairs);

// --- baselines: DPD descending and outstanding descending ---
const dpdPairs = loans.map((loan) => ({ p: loan.dpd, y: loan.rolled }));
const dpd = metrics(dpdPairs);
const outstandingPairs = loans.map((loan) => ({ p: loan.outstanding, y: loan.rolled }));
const outstanding = metrics(outstandingPairs);

// --- bootstrap 95% CI for the AUC (resample the cohort, 1000 draws) ---
let rngState = 20261108;
const nextRandom = (): number => {
  // xorshift32 — deterministic, no Math.random in a report.
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return ((rngState >>> 0) % 1_000_000) / 1_000_000;
};
const BOOTSTRAP_DRAWS = 1000;
const bootstrapAucs: number[] = [];
for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
  const sample: { p: number; y: boolean }[] = [];
  for (let i = 0; i < loans.length; i += 1) {
    const picked = loans[Math.floor(nextRandom() * loans.length)]!;
    sample.push({ p: picked.pRoll, y: picked.rolled });
  }
  const a = auc(sample);
  if (Number.isFinite(a)) {
    bootstrapAucs.push(a);
  }
}
bootstrapAucs.sort((a, b) => a - b);
const ciLow = bootstrapAucs[Math.floor(0.025 * bootstrapAucs.length)]!;
const ciHigh = bootstrapAucs[Math.ceil(0.975 * bootstrapAucs.length) - 1]!;

// --- where the score was wrong ---
const curedSorted = loans.filter((loan) => !loan.rolled).sort((a, b) => b.pRoll - a.pRoll).slice(0, 10);
const rolledSorted = loans.filter((loan) => loan.rolled).sort((a, b) => a.pRoll - b.pRoll).slice(0, 10);

const fmt = (value: number): string => (Number.isFinite(value) ? value.toFixed(3) : 'n/a');
const rollRate = loans.filter((loan) => loan.rolled).length / loans.length;

const report = `# Back-test: priority scorecard at t0 = ${t0}

**Cohort**: every loan in 1-30 DPD at the t0 snapshot (n = ${loans.length}); outcome = rolled to 31+ DPD by the end snapshot ${t0End} (actual roll rate ${(100 * rollRate).toFixed(1)}%).
**Inputs at t0 only**: DPD and outstanding from the t0 snapshot, promises and contact events strictly before t0, static loan attributes. The t0 overdue amount is not in the snapshot — that feature imputed the portfolio mean for ${limitedCount} of ${loans.length} loans (limited data), stated plainly.
**Model**: the committed scorecard (model ${weights.modelVersion}) with the committed standardisation params (fitted at the end date — portfolio means/SDs, not outcome-derived). The weights are the SPEC's expert priors and were **not** tuned against this result.
**Split**: time-based (t0 history vs the fixed +30-day outcome window). No random split.

| scorer | AUC | Gini | KS | Brier |
| --- | --- | --- | --- | --- |
| Scorecard | ${fmt(model.auc)} (95% bootstrap CI ${fmt(ciLow)}–${fmt(ciHigh)}) | ${fmt(model.gini)} | ${fmt(model.ks)} | ${fmt(model.brier)} |
| Baseline: DPD descending | ${fmt(dpd.auc)} | ${fmt(dpd.gini)} | ${fmt(dpd.ks)} | ${fmt(dpd.brier)} |
| Baseline: outstanding descending | ${fmt(outstanding.auc)} | ${fmt(outstanding.gini)} | ${fmt(outstanding.ks)} | ${fmt(outstanding.brier)} |

**The honest value-add is the delta over the DPD baseline: ΔAUC = ${(model.auc - dpd.auc).toFixed(3)}.**

The data is synthetic, so this proves the pipeline works, not real-world accuracy.

## Decile table — scorecard

${decileTable(modelPairs).join('\n')}

## Decile table — DPD baseline

${decileTable(dpdPairs).join('\n')}

## Calibration (scorecard, by predicted decile)

Mean predicted vs actual roll rate per decile — the first table's "mean predicted" and "actual roll rate" columns are the calibration view; a calibrated model has the two columns close on every row.

## Where the score was wrong

### Top 10 high-score loans that cured (the model over-rated them)

| loan | score | predicted | DPD at t0 | outstanding |
| --- | --- | --- | --- | --- |
${curedSorted
  .map((loan) => `| ${loan.loanId} | ${loan.entry.score} | ${(100 * loan.pRoll).toFixed(1)}% | ${loan.dpd} | ${loan.outstanding} |`)
  .join('\n')}

### Top 10 low-score loans that rolled (the model under-rated them)

| loan | score | predicted | DPD at t0 | outstanding |
| --- | --- | --- | --- | --- |
${rolledSorted
  .map((loan) => `| ${loan.loanId} | ${loan.entry.score} | ${(100 * loan.pRoll).toFixed(1)}% | ${loan.dpd} | ${loan.outstanding} |`)
  .join('\n')}
`;

const outPath = new URL('../docs/backtest.md', import.meta.url);
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, report);
console.log(`[backtest] t0 ${t0} -> end ${t0End}, n = ${loans.length}, roll rate ${(100 * rollRate).toFixed(1)}%`);
console.log(`[backtest] scorecard AUC ${fmt(model.auc)} (CI ${fmt(ciLow)}-${fmt(ciHigh)}), DPD baseline ${fmt(dpd.auc)}, outstanding baseline ${fmt(outstanding.auc)}`);
console.log(`[backtest] wrote ${outPath.pathname}`);
await closePool();
