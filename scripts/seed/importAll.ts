/**
 * Seed import run (prompt 8, SPEC 14): push the 77 generated daily files
 * through THE REAL importer, one file per day, oldest first. The per-file
 * work — parse (headers/validation/warnings), plan against the previously
 * committed snapshot (aborts for backdated as-of, >40% vanished, halved
 * counts), loan upserts, gone→cleared transitions, the assignment runner —
 * is exactly what POST /api/import does, so the seeded history walks the
 * same production path the demo users will later see.
 *
 * This module is deliberately DB-free: the applyImport call is injected, so
 * tests can drive the sequencing, actor and manifest logic without a
 * database, and the live runner (scripts/seed/main.ts) passes the real
 * server function. Any rejected file aborts the whole run with the abort
 * surfaced verbatim — a rejected file means the generated history violates
 * the importer contract, which must stop the seed before later files build
 * on a hole.
 */
import { ASSIGNMENT_REASONS } from '../../src/shared/assignment.js';
import type { AssignmentReason } from '../../src/shared/assignment.js';
import type { ApplyImportOutcome } from '../../src/server/import/applyImport.js';
import type { StoredImportReport } from '../../src/server/import/applyImport.js';
import type { HistoryFile } from './history.js';

export interface SeedImportActor {
  userId: string | null;
  username: string;
}

export interface SeedApplyInput {
  bytes: Uint8Array;
  filename: string;
  asOf: string;
  actor: SeedImportActor;
}

export type SeedApplyImport = (input: SeedApplyInput) => Promise<ApplyImportOutcome>;

export interface BatchRunEntry {
  date: string;
  filename: string;
  status: ApplyImportOutcome['status'];
  batchId: string | null;
  counts: Pick<
    StoredImportReport,
    'totalRows' | 'imported' | 'dropped' | 'skipped' | 'new' | 'lateDiscovery' | 'aging' | 'partPaid' | 'anomalous' | 'gone'
  >;
  warnings: number;
  errors: number;
  assignment: Record<AssignmentReason, number> | null;
}

export interface ImportAllTotals {
  new: number;
  lateDiscovery: number;
  aging: number;
  partPaid: number;
  anomalous: number;
  gone: number;
  warnings: number;
  errors: number;
}

export interface ImportAllOutcome {
  batches: BatchRunEntry[];
  totals: ImportAllTotals;
  assignmentTotals: Record<AssignmentReason, number>;
}

export function zeroAssignmentTotals(): Record<AssignmentReason, number> {
  return Object.fromEntries(ASSIGNMENT_REASONS.map((reason) => [reason, 0])) as Record<AssignmentReason, number>;
}

export async function importAllHistory(input: {
  files: readonly HistoryFile[];
  apply: SeedApplyImport;
  actor: SeedImportActor;
  /** Optional per-file progress hook (main.ts prints every N files). */
  onFileDone?: (index: number, total: number, entry: BatchRunEntry) => void;
}): Promise<ImportAllOutcome> {
  const files = input.files;
  if (files.length === 0) {
    throw new Error('import: the generated file set is empty');
  }
  for (let i = 1; i < files.length; i += 1) {
    if (!(files[i]!.date > files[i - 1]!.date)) {
      throw new Error(`import: file set must be chronologically ordered; ${files[i]!.filename} does not follow ${files[i - 1]!.filename}`);
    }
  }

  const batches: BatchRunEntry[] = [];
  const totals: ImportAllTotals = { new: 0, lateDiscovery: 0, aging: 0, partPaid: 0, anomalous: 0, gone: 0, warnings: 0, errors: 0 };
  const assignmentTotals = zeroAssignmentTotals();

  for (const file of files) {
    const bytes = new TextEncoder().encode(file.csv);
    const outcome = await input.apply({ bytes, filename: file.filename, asOf: file.date, actor: input.actor });
    if (outcome.status === 'rejected') {
      throw new Error(`import: ${file.filename} (as_of ${file.date}) was rejected: ${outcome.abort.code}: ${outcome.abort.message}`);
    }
    const report = outcome.report;
    const entry: BatchRunEntry = {
      date: file.date,
      filename: file.filename,
      status: outcome.status,
      batchId: outcome.batchId,
      counts: {
        totalRows: report.totalRows,
        imported: report.imported,
        dropped: report.dropped,
        skipped: report.skipped,
        new: report.new,
        lateDiscovery: report.lateDiscovery,
        aging: report.aging,
        partPaid: report.partPaid,
        anomalous: report.anomalous,
        gone: report.gone
      },
      warnings: report.warnings,
      errors: report.errors,
      assignment: report.assignment ?? null
    };
    batches.push(entry);
    input.onFileDone?.(batches.length, files.length, entry);
    totals.new += report.new;
    totals.lateDiscovery += report.lateDiscovery;
    totals.aging += report.aging;
    totals.partPaid += report.partPaid;
    totals.anomalous += report.anomalous;
    totals.gone += report.gone;
    totals.warnings += report.warnings;
    totals.errors += report.errors;
    if (report.assignment) {
      for (const reason of ASSIGNMENT_REASONS) {
        assignmentTotals[reason] += report.assignment[reason] ?? 0;
      }
    }
  }

  return { batches, totals, assignmentTotals };
}
