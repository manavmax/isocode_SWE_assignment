/**
 * fit-standardisation (prompt 12 item 1): compute the scorecard's
 * standardisation means and SDs (population) and the last-contact outcome
 * shares from the SEEDED data, and write src/shared/scoring/params.json
 * (committed). runScoring and the back-test both load this file, so the
 * fitted constants cannot drift between serving and evaluation.
 *
 * Local-only maintenance script, same safety shape as the other db scripts:
 * requires DATABASE_URL (the .env database), refuses to run without it.
 * The output names the as_of and the row count it was fitted from.
 */
import { writeFileSync } from 'node:fs';
import { closePool, getPool } from '../src/server/db.js';
import { collectLoanFeatures } from '../src/server/scoring/features.js';
import { weights } from '../src/shared/scoring/scorecard.js';
import { istDateKey } from '../src/shared/datetime.js';

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const asOf = process.argv[2] ?? istDateKey(Date.now());
failUnless(/^\d{4}-\d{2}-\d{2}$/.test(asOf), 'usage: tsx scripts/fit-standardisation.ts [asOf YYYY-MM-DD]');

const pool = getPool();
const batch = (
  await pool.query(`SELECT max(as_of)::text AS latest FROM import_batch`)
).rows[0] as { latest: string | null };
const fitAsOf = batch.latest ? batch.latest.slice(0, 10) : asOf;

const loans = await collectLoanFeatures(fitAsOf);
failUnless(loans.length > 0, `no overdue loans found for ${fitAsOf} — run the seed first`);

function meanSd(values: number[]): { mean: number; sd: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  // Floor the SD at 5% of the mean (and at a small epsilon): a degenerate
  // feature (the seed's overdue is exactly 12 EMIs for every loan) must not
  // turn rounding noise into a clipped z of ±3.
  const sd = Math.max(Math.sqrt(variance), Math.abs(mean) * 0.05, 1e-6);
  return { mean: Math.round(mean * 1e6) / 1e6, sd: Math.round(sd * 1e6) / 1e6 };
}

const emiOf = (loan: (typeof loans)[number]): number | null =>
  loan.features.emi && loan.features.emi > 0 && loan.features.overdue !== null ? loan.features.overdue / loan.features.emi : null;
const logOutstandingOf = (loan: (typeof loans)[number]): number | null =>
  loan.features.outstanding !== null ? Math.log1p(loan.features.outstanding) : null;
const keptRateOf = (loan: (typeof loans)[number]): number =>
  (loan.features.keptKept! + weights.keptRateShrinkage.addedKept) / (loan.features.keptMade! + weights.keptRateShrinkage.addedMade);

const pick = (feature: keyof typeof loans[number]['features']): number[] =>
  loans.map((loan) => loan.features[feature]).filter((v): v is number => v !== null);

const params = {
  modelVersion: weights.modelVersion,
  fittedAt: new Date().toISOString(),
  fittedFromAsOf: fitAsOf,
  n: loans.length,
  features: {
    dpd: meanSd(pick('dpd')),
    bounces: meanSd(pick('bounces')),
    broken90: meanSd(pick('broken90')),
    keptRate: meanSd(loans.map(keptRateOf)),
    daysSinceContact: meanSd(pick('daysSinceContact')),
    overdueEmiMultiples: meanSd(loans.map(emiOf).filter((v): v is number => v !== null)),
    logOutstanding: meanSd(loans.map(logOutstandingOf).filter((v): v is number => v !== null)),
    vintageMonths: meanSd(pick('vintageMonths'))
  },
  outcomeShares: Object.fromEntries(
    (['unreachable', 'refused', 'promised', 'part_paid'] as const).map((group) => [
      group,
      Math.round((loans.filter((loan) => loan.features.lastOutcomeGroup === group).length / loans.length) * 1e6) / 1e6
    ])
  )
};

const outPath = new URL('../src/shared/scoring/params.json', import.meta.url);
writeFileSync(outPath, `${JSON.stringify(params, null, 2)}\n`);
console.log(`[fit-standardisation] fitted ${loans.length} overdue loans at as_of ${fitAsOf}`);
console.log(`[fit-standardisation] wrote ${outPath.pathname}`);
for (const [feature, stats] of Object.entries(params.features)) {
  console.log(`  ${feature.padEnd(20)} mean ${String(stats.mean).padStart(10)} sd ${String(stats.sd).padStart(10)}`);
}
await closePool();
