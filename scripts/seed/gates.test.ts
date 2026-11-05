import { describe, expect, it } from 'vitest';
import {
  decideRun,
  parseSeedArgs,
  planResetAudit,
  resolveAsOf,
  resetDemoData,
  validateResetTables,
  weekdayOf
} from './gates.js';

describe('parseSeedArgs', () => {
  it('parses the documented invocation flags', () => {
    expect(parseSeedArgs(['--seed', '20261105', '--as-of', 'today', '--yes'])).toEqual({
      seed: 20261105,
      asOfRequest: 'today',
      yes: true,
      reset: false
    });
  });

  it('recognises --reset and defaults both write flags off', () => {
    expect(parseSeedArgs(['--seed', '7', '--as-of', '2026-10-20'])).toEqual({
      seed: 7,
      asOfRequest: '2026-10-20',
      yes: false,
      reset: false
    });
    expect(parseSeedArgs(['--seed', '7', '--as-of', 'today', '--reset']).reset).toBe(true);
  });

  it('rejects missing or non-integer seeds and unknown flags', () => {
    expect(() => parseSeedArgs(['--as-of', 'today'])).toThrow(/--seed/);
    expect(() => parseSeedArgs(['--seed', '20^1105', '--as-of', 'today'])).toThrow(/--seed/);
    expect(() => parseSeedArgs(['--seed', '2026.5', '--as-of', 'today'])).toThrow(/--seed/);
    expect(() => parseSeedArgs(['--seed', '20261105'])).toThrow(/--as-of/);
    expect(() => parseSeedArgs(['--seed', '20261105', '--as-of', 'today', '--force'])).toThrow(/unknown seed option/);
  });
});

describe('resolveAsOf', () => {
  it('maps "today" onto the UTC run date and passes canonical dates through', () => {
    expect(resolveAsOf('today', '2026-11-05')).toBe('2026-11-05');
    expect(resolveAsOf('2026-11-05', '2027-01-01')).toBe('2026-11-05');
  });

  it('rejects anything that is not "today" or a canonical YYYY-MM-DD date', () => {
    expect(() => resolveAsOf('tomorrow', '2026-11-05')).toThrow(/--as-of/);
    expect(() => resolveAsOf('2026-11-5', '2026-11-05')).toThrow(/--as-of/);
    expect(() => resolveAsOf('2026-02-29', '2026-11-05')).toThrow(/--as-of/); // not a leap year
    expect(() => resolveAsOf('2026-13-01', '2026-11-05')).toThrow(/--as-of/);
  });
});

describe('weekdayOf', () => {
  it('splits the two decided dates: 2026-11-05 is a Thursday, 2026-10-04 a Sunday', () => {
    expect(weekdayOf('2026-11-05')).toBe(4);
    expect(weekdayOf('2026-10-04')).toBe(0);
    expect(weekdayOf('2026-10-06')).toBe(2); // the t0 date = k=30
  });
});

describe('decideRun', () => {
  const base = {
    asOf: '2026-11-05',
    cohortDaysBeforeEnd: 30,
    yes: true,
    resetRequested: false,
    demoMode: true,
    data: { hasAnyRow: false, allDemo: true, latestImportDate: null }
  };

  it('proceeds on a weekday as-of over an empty demo-mode database', () => {
    expect(decideRun(base)).toEqual({ action: 'proceed', reset: false });
  });

  it('refuses without DEMO_MODE, an unsuitable as-of/--yes pair, or non-demo data', () => {
    expect(decideRun({ ...base, demoMode: false }).action).toBe('refuse');
    expect(decideRun({ ...base, demoMode: false }).reason).toMatch(/DEMO_MODE/);

    expect(decideRun({ ...base, yes: false }).reason).toMatch(/--yes/);

    // 2026-11-08 is the Sunday right after the run date
    expect(decideRun({ ...base, asOf: '2026-11-08' }).reason).toMatch(/Sunday/);

    // Tuesday as-of puts the cohort day t0 = asOf - 30 on a Sunday (2026-10-04)
    expect(decideRun({ ...base, asOf: '2026-11-03' }).reason).toMatch(/cohort day t0/);

    expect(decideRun({ ...base, data: { hasAnyRow: true, allDemo: false, latestImportDate: null } }).reason).toMatch(
      /--reset/
    );

    // an import batch newer than the window would abort the chronological
    // import as backdated — refuse before anything is written
    expect(decideRun({ ...base, data: { hasAnyRow: false, allDemo: true, latestImportDate: '2026-12-01' } }).reason).toMatch(
      /backdated/
    );
    expect(
      decideRun({ ...base, resetRequested: true, data: { hasAnyRow: false, allDemo: true, latestImportDate: '2026-12-01' } }).action
    ).toBe('proceed');
  });

  it('--reset clears the non-demo refusal and survives the matrix when combined', () => {
    expect(
      decideRun({ ...base, resetRequested: true, data: { hasAnyRow: true, allDemo: false, latestImportDate: null } })
    ).toEqual({
      action: 'proceed',
      reset: true
    });
    expect(
      decideRun({ ...base, resetRequested: true, data: { hasAnyRow: true, allDemo: true, latestImportDate: null } })
    ).toEqual({
      action: 'proceed',
      reset: true
    });
  });

  it('reports every violated rule together, DEMO_MODE first', () => {
    const decision = decideRun({
      ...base,
      demoMode: false,
      yes: false,
      data: { hasAnyRow: true, allDemo: false, latestImportDate: null }
    });
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toMatch(/^DEMO_MODE/);
    expect(decision.reason).toMatch(/--yes/);
    expect(decision.reason).toMatch(/--reset/);
  });
});

describe('reset scope', () => {
  it('keeps the config table list as lowercase identifiers in config order', () => {
    expect(validateResetTables(['loan', 'app_user', 'branch'])).toEqual(['loan', 'app_user', 'branch']);
  });

  it('rejects empty, duplicated, quoted or SQL-shaped table names', () => {
    expect(() => validateResetTables([])).toThrow(/reset_tables/);
    expect(() => validateResetTables(['loan', 'loan', 'app_user'])).toThrow(/reset_tables/);
    expect(() => validateResetTables(['"loan"'])).toThrow(/reset_tables/);
    expect(() => validateResetTables(['drop table app_user'])).toThrow(/reset_tables/);
    expect(() => validateResetTables(['Loan'])).toThrow(/reset_tables/);
  });
});

describe('reset execution', () => {
  it('writes the audit row before the single TRUNCATE statement, inside one transaction', async () => {
    const record: string[] = [];
    let began = 0;
    const fakeTx = {
      insert: () => ({
        values: async (row: unknown) => {
          record.push(`audit:${JSON.stringify(row)}`);
        }
      }),
      execute: async (query: { queryChunks: readonly { value: string }[] }) => {
        record.push(`sql:${query.queryChunks.map((chunk) => chunk.value).join('')}`);
      }
    };
    await resetDemoData(
      { run: async (fn) => ((began += 1), await fn(fakeTx as never)) },
      { seed: 20261105, asOf: '2026-11-05', tables: ['contact_event', 'promise', 'loan', 'app_user'] }
    );
    expect(began).toBe(1);
    expect(record).toHaveLength(2);
    expect(record[0]).toContain('"action":"demo_reset"');
    expect(record[0]).toContain('"seed":20261105');
    expect(record[0]).toContain('"asOf":"2026-11-05"');
    expect(record[0]).toContain('contact_event');
    expect(record[1]).toBe('sql:TRUNCATE TABLE "contact_event", "promise", "loan", "app_user"');
    expect(planResetAudit({ seed: 20261105, asOf: '2026-11-05', tables: ['loan'] })).toMatchObject({
      actor: 'seed',
      action: 'demo_reset'
    });
  });
});
