/**
 * runScoring (SPEC 8, prompt 12 item 5): score the end-active book for an
 * as_of, order the worklist (promise-due pinned, then rupees at risk, low
 * lane last) and persist immutable score_log rows keyed (loan_id, as_of) —
 * the unique constraint makes a rerun for the same as_of an upsert that
 * writes no duplicates. model_version travels on every row so a back-test
 * can freeze and compare honestly.
 *
 * "Never fake the model": if scoring throws (params missing, model
 * mismatch), the run reports fallback mode and writes NOTHING — the caller
 * (assignments response, client) then orders by broken promise, DPD,
 * overdue and labels the list "standard order".
 */
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withTx } from '../db.js';
import { scoreLog } from '../db/schema.js';
import {
  scoreLoan,
  weights,
  worklistOrder,
  type ScoredLoan,
  type StandardisationParams,
  type WorklistEntry
} from '../../shared/scoring/scorecard.js';
import { collectLoanFeatures } from './features.js';

export const paramsPath = fileURLToPath(new URL('../../shared/scoring/params.json', import.meta.url));

export function loadParams(): StandardisationParams {
  return JSON.parse(readFileSync(paramsPath, 'utf8')) as StandardisationParams;
}

export interface ScoreLogInsert {
  loanId: string;
  pRoll: number;
  score: number;
  rank: number;
  rupeesAtRisk: number;
  reasons: ScoredLoan['topReasons'];
  features: Record<string, unknown>;
  modelVersion: string;
}

export interface ScoringRunOutcome {
  asOf: string;
  scored: number;
  lowLane: number;
  pinned: number;
  fallback: boolean;
  modelVersion: string;
  failedLoans: number;
}

/** Scores the book; returns the rows ready for score_log. Throws only when
 *  the MODEL itself cannot run (the caller decides the fallback). */
export function scoreBook(
  asOf: string,
  loans: Awaited<ReturnType<typeof collectLoanFeatures>>,
  params: StandardisationParams
): ScoreLogInsert[] {
  const scored: (WorklistEntry & { insert: ScoreLogInsert })[] = [];
  for (const loan of loans) {
    const result = scoreLoan({ features: loan.features, params });
    scored.push({
      loanId: loan.loanId,
      pRoll: result.pRoll,
      score: result.score,
      band: result.band,
      rupeesAtRisk: Math.round(result.pRoll * (loan.features.overdue ?? 0)),
      hasBrokenPromise: loan.hasBrokenPromise,
      duePromise: loan.duePromise,
      insert: {
        loanId: loan.loanId,
        pRoll: result.pRoll,
        score: result.score,
        rank: 0,
        rupeesAtRisk: Math.round(result.pRoll * (loan.features.overdue ?? 0)),
        reasons: result.topReasons,
        features: {
          raw: loan.features,
          limitedData: result.limitedData,
          band: result.band,
          hasBrokenPromise: loan.hasBrokenPromise,
          duePromise: loan.duePromise
        },
        modelVersion: weights.modelVersion
      }
    });
  }
  const ordered = worklistOrder(scored, weights);
  return ordered.map((entry, index) => ({ ...entry.insert, rank: index + 1 }));
}

export async function runScoring(asOf: string): Promise<ScoringRunOutcome> {
  const loans = await collectLoanFeatures(asOf);
  let inserts: ScoreLogInsert[];
  try {
    const params = loadParams();
    inserts = scoreBook(asOf, loans, params);
  } catch {
    // Never fake the model: no rows written, the response falls back.
    return { asOf, scored: 0, lowLane: 0, pinned: 0, fallback: true, modelVersion: weights.modelVersion, failedLoans: loans.length };
  }

  await withTx(async (tx) => {
    for (const row of inserts) {
      await tx
        .insert(scoreLog)
        .values({
          loanId: row.loanId,
          asOf,
          pRoll: row.pRoll,
          score: row.score,
          rank: row.rank,
          rupeesAtRisk: row.rupeesAtRisk,
          reasonsJson: row.reasons,
          featuresJson: row.features,
          modelVersion: row.modelVersion
        })
        .onConflictDoUpdate({
          target: [scoreLog.loanId, scoreLog.asOf],
          set: {
            pRoll: sql`excluded.p_roll`,
            score: sql`excluded.score`,
            rank: sql`excluded.rank`,
            rupeesAtRisk: sql`excluded.rupees_at_risk`,
            reasonsJson: sql`excluded.reasons_json`,
            featuresJson: sql`excluded.features_json`,
            modelVersion: sql`excluded.model_version`
          }
        });
    }
  });

  return {
    asOf,
    scored: inserts.length,
    lowLane: inserts.filter((row) => (row.features as { band?: string }).band === 'low').length,
    pinned: inserts.filter((row) => (row.features as { duePromise?: boolean }).duePromise === true).length,
    fallback: false,
    modelVersion: weights.modelVersion,
    failedLoans: 0
  };
}
