import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse } from './loans.js';
import { buildHistory } from './history.js';
import { mulberry32 } from './rng.js';
import { importAllHistory, zeroAssignmentTotals, type SeedApplyImport, type SeedImportActor, type SeedApplyInput } from './importAll.js';
import type { ApplyImportOutcome, StoredImportReport } from '../../src/server/import/applyImport.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);
const universe = buildLoanUniverse(mulberry32(20261105), config, 20261105);
const history = buildHistory(mulberry32(777), config, universe, '2026-11-05');
const actor: SeedImportActor = { userId: '11111111-1111-1111-1111-111111111111', username: 'kavita.rathore' };

type ImportedOutcome = Extract<ApplyImportOutcome, { status: 'imported' | 'replaced' }>;

function slimFiles(count: number) {
  return history.files.slice(0, count);
}

function cannedReport(args: SeedApplyInput, overrides: Partial<StoredImportReport> = {}): ImportedOutcome {
  void args;
  const report: StoredImportReport = {
    totalRows: 10,
    imported: 10,
    dropped: 0,
    skipped: 0,
    new: 4,
    lateDiscovery: 0,
    aging: 6,
    partPaid: 0,
    anomalous: 0,
    gone: 1,
    warnings: 0,
    errors: 0,
    assignment: { ...zeroAssignmentTotals(), new_assigned: 3 }
  };
  return { status: 'imported', batchId: '22222222-2222-2222-2222-222222222222', report: { ...report, ...overrides } };
}

describe('importAllHistory', () => {
  it('feeds the real applyImport one file at a time, chronologically, with the seed actor', async () => {
    const seen: { filename: string; asOf: string; bytes: string; actor: SeedImportActor; status: string }[] = [];
    const apply: SeedApplyImport = async (input) => {
      seen.push({
        filename: input.filename,
        asOf: input.asOf,
        bytes: new TextDecoder().decode(input.bytes),
        actor: input.actor,
        status: 'imported'
      });
      return cannedReport(input, {});
    };
    const files = slimFiles(3);
    const outcome = await importAllHistory({ files, apply, actor });
    expect(seen).toHaveLength(3);
    expect(seen.map((call) => call.asOf)).toEqual(files.map((file) => file.date));
    expect(seen.map((call) => call.filename)).toEqual(files.map((file) => file.filename));
    expect(seen[0]!.bytes).toBe(files[0]!.csv);
    for (const call of seen) {
      expect(call.actor).toEqual(actor);
      expect(call.status).toBe('imported');
    }
    expect(outcome.batches.map((entry) => entry.date)).toEqual(files.map((file) => file.date));
    expect(outcome.batches.every((entry) => entry.status === 'imported')).toBe(true);
    expect(outcome.totals.new).toBe(12);
    expect(outcome.totals.aging).toBe(18);
    expect(outcome.totals.gone).toBe(3);
    expect(outcome.totals.warnings).toBe(0);
  });

  it('throws naming the date, filename and abort when the importer rejects a file', async () => {
    let calls = 0;
    const apply: SeedApplyImport = async (input) => {
      calls += 1;
      if (calls === 2) {
        return {
          status: 'rejected',
          abort: { code: 'vanished_over_40pct', message: '9 of 22 absent' },
          counts: cannedReport(input, {}).report
        };
      }
      return cannedReport(input, {});
    };
    await expect(importAllHistory({ files: slimFiles(3), apply, actor })).rejects.toThrow(
      /overdue_[\d-]+\.csv.*vanished_over_40pct.*9 of 22/
    );
  });

  it('accepts noop outcomes (idempotent reseed) and keeps their stored counts', async () => {
    const apply: SeedApplyImport = async (input) => ({
      status: 'noop',
      batchId: 'noop-batch',
      report: cannedReport(input, {}).report
    });
    const outcome = await importAllHistory({ files: slimFiles(2), apply, actor });
    expect(outcome.batches.map((entry) => entry.status)).toEqual(['noop', 'noop']);
    expect(outcome.totals.new).toBe(8);
  });

  it('refuses to run when the file set is not chronologically ordered', async () => {
    const apply: SeedApplyImport = async (input) => cannedReport(input, {});
    const reversed = [...slimFiles(3)].reverse();
    await expect(importAllHistory({ files: reversed, apply, actor })).rejects.toThrow(/chronolog/);
    await expect(importAllHistory({ files: reversed.slice().sort((a, b) => a.date.localeCompare(b.date)).reverse(), apply, actor })).rejects.toThrow(
      /chronolog/
    );
  });

  it('reports progress with 1-based indexes and running totals', async () => {
    const apply: SeedApplyImport = async (input) => cannedReport(input, {});
    const seen: string[] = [];
    await importAllHistory({
      files: slimFiles(2),
      apply,
      actor,
      onFileDone: (index, total, entry) => seen.push(`${index}/${total}:${entry.date}`)
    });
    expect(seen).toEqual([`1/2:${slimFiles(2)[0]!.date}`, `2/2:${slimFiles(2)[1]!.date}`]);
  });
});
