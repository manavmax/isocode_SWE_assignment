import { describe, expect, it } from 'vitest';
import {
  cohortSanitySql,
  footingProblems,
  formatBucketMix,
  formatCohortResults,
  formatDemoAccounts,
  formatOfficerCounts,
  rollPct,
  type BucketRow,
  type CohortRow,
  type DemoAccountRow,
  type OfficerCountRow
} from './summary.js';

describe('cohortSanitySql', () => {
  it('embeds the two snapshot dates and returns one row per branch plus the footing total', () => {
    const sql = cohortSanitySql('2026-10-06', '2026-11-05');
    expect(sql).toContain("DATE '2026-10-06'");
    expect(sql).toContain("DATE '2026-11-05'");
    expect(sql).toContain('loan_snapshot');
    expect(sql).toContain('dpd BETWEEN 1 AND 30');
    expect(sql).toContain('GROUPING SETS');
    expect(sql).toContain('cured');
    expect(sql).toContain('stayed');
    expect(sql).toContain('rolled');
    expect(sql).toContain('roll_pct');
    expect(sql).toContain('footing_ok');
  });
});

describe('rollPct', () => {
  it('formats rolled / cohort_n as one decimal', () => {
    expect(rollPct({ cohortN: 68, rolled: 15 })).toBe('22.1');
    expect(rollPct({ cohortN: 27, rolled: 6 })).toBe('22.2');
    expect(rollPct({ cohortN: 0, rolled: 0 })).toBe('n/a');
  });
});

describe('footingProblems', () => {
  it('is empty when cured + stayed + rolled equals cohort_n on every row', () => {
    const rows: CohortRow[] = [
      { branch: 'Indore', cohortN: 68, cured: 43, stayed: 10, rolled: 15 },
      { branch: 'Dewas', cohortN: 27, cured: 17, stayed: 4, rolled: 6 },
      { branch: '(all branches)', cohortN: 136, cured: 83, stayed: 22, rolled: 31 }
    ];
    expect(footingProblems(rows)).toEqual([]);
  });

  it('names every row whose outcome split does not foot', () => {
    const rows: CohortRow[] = [
      { branch: 'Indore', cohortN: 68, cured: 44, stayed: 10, rolled: 15 },
      { branch: 'Ujjain', cohortN: 41, cured: 23, stayed: 8, rolled: 11 }
    ];
    expect(footingProblems(rows)).toEqual(['Indore', 'Ujjain']);
  });
});

describe('formatCohortResults', () => {
  it('renders the header, one aligned line per row and the footing verdict', () => {
    const lines = formatCohortResults([
      { branch: 'Dewas', cohortN: 27, cured: 17, stayed: 4, rolled: 6 },
      { branch: 'Indore', cohortN: 68, cured: 43, stayed: 10, rolled: 15 },
      { branch: 'Ujjain', cohortN: 41, cured: 23, stayed: 8, rolled: 10 },
      { branch: '(all branches)', cohortN: 136, cured: 83, stayed: 22, rolled: 31 }
    ]);
    expect(lines[0]).toBe('  branch          cohort_n  cured  stayed  rolled   roll%');
    expect(lines).toContain('  Dewas                27     17      4      6    22.2%');
    expect(lines).toContain('  Indore               68     43     10     15    22.1%');
    expect(lines).toContain('  Ujjain               41     23      8     10    24.4%');
    expect(lines).toContain('  (all branches)      136     83     22     31    22.8%');
    expect(lines.at(-1)).toBe('  footing: cured + stayed + rolled = cohort_n holds on every row');
  });

  it('reports a footing failure loudly instead of the OK line', () => {
    const lines = formatCohortResults([{ branch: 'Indore', cohortN: 68, cured: 44, stayed: 10, rolled: 15 }]);
    expect(lines.at(-1)).toBe('  FOOTING MISMATCH: Indore');
  });
});

describe('formatOfficerCounts', () => {
  it('groups officers under their branch and appends the queue and cleared lines', () => {
    const rows: OfficerCountRow[] = [
      { branch: 'Dewas', officer: 'Murlidhar Garg', loans: 17 },
      { branch: 'Dewas', officer: 'Neha Solanki', loans: 16 },
      { branch: 'Indore', officer: 'Rahul Chouhan', loans: 23 }
    ];
    const lines = formatOfficerCounts(rows, 6, 83);
    expect(lines[0]).toBe('  branch  officer                loans');
    expect(lines).toContain('  Dewas   Murlidhar Garg          17');
    expect(lines).toContain('  Indore  Rahul Chouhan           23');
    expect(lines).toContain('  queue (no officer, branch manager)           6');
    expect(lines).toContain('  cleared by the end date (status=cleared)    83');
  });
});

describe('formatDemoAccounts (step 0.5: linked chips, the joiner, the demo bar)', () => {
  const rows: DemoAccountRow[] = [
    { username: 'demo-manager', role: 'branch_manager', officerName: 'kavita.rathore', worklist: 0, assignedAny: 0 },
    { username: 'demo-officer-1', role: 'field_officer', officerName: 'Rahul Chouhan', worklist: 31, assignedAny: 34 },
    { username: 'demo-officer-2', role: 'field_officer', officerName: 'Neha Solanki', worklist: 17, assignedAny: 19 },
    { username: 'demo-officer-3', role: 'field_officer', officerName: 'Demo Officer 3', worklist: 0, assignedAny: 0 }
  ];

  it('prints each demo username with the person it acts as and its loan counts', () => {
    const lines = formatDemoAccounts(rows);
    expect(lines[0]).toBe('  demo accounts (worklist = status=overdue):');
    expect(lines[1]).toBe('  username          officer             worklist  assigned');
    // The column contract: '  ' + username.padEnd(17) + ' ' + officer.padEnd(19) + ' ' + worklist.padStart(8) + ' ' + assigned.padStart(9)
    const line = (username: string, officer: string, worklist: string, assigned: string): string =>
      `  ${username.padEnd(17)} ${officer.padEnd(19)} ${worklist.padStart(8)} ${assigned.padStart(9)}`;
    expect(lines).toContain(line('demo-manager', 'kavita.rathore', '0', '0'));
    expect(lines).toContain(line('demo-officer-1', 'Rahul Chouhan', '31', '34'));
    expect(lines).toContain(line('demo-officer-2', 'Neha Solanki', '17', '19'));
    expect(lines).toContain(line('demo-officer-3', 'Demo Officer 3', '0', '0'));
  });

  it('warns when a linked chip sits below its demo bar (10) but never for the joiner or the manager', () => {
    const starved: DemoAccountRow[] = [
      { username: 'demo-manager', role: 'branch_manager', officerName: 'kavita.rathore', worklist: 0, assignedAny: 0 },
      { username: 'demo-officer-1', role: 'field_officer', officerName: 'Rahul Chouhan', worklist: 9, assignedAny: 9 },
      { username: 'demo-officer-2', role: 'field_officer', officerName: 'Neha Solanki', worklist: 17, assignedAny: 19 },
      { username: 'demo-officer-3', role: 'field_officer', officerName: 'Demo Officer 3', worklist: 0, assignedAny: 0 }
    ];
    const lines = formatDemoAccounts(starved);
    expect(lines.at(-1)).toBe(
      '  WARNING: demo worklist below the demo bar for demo-officer-1 (9 < 10) — seed missing, demo account not linked to its staff officer, or the deployment points at a different database'
    );
  });

  it('stays silent when every chip meets its demo bar', () => {
    const lines = formatDemoAccounts(rows);
    expect(lines.some((line) => line.includes('WARNING'))).toBe(false);
  });
});

describe('formatBucketMix', () => {
  it('renders bucket counts and shares of the end-active total', () => {
    const rows: BucketRow[] = [
      { bucket: '1-30', loans: 119 },
      { bucket: '31-60', loans: 31 },
      { bucket: '61-90', loans: 30 }
    ];
    const lines = formatBucketMix(rows, 180);
    expect(lines[0]).toBe('  bucket   loans   share');
    expect(lines).toContain('  1-30      119    66.1%');
    expect(lines).toContain('  61-90      30    16.7%');
    expect(lines).toContain('  total     180   100.0%');
  });

  it('warns when the overdue total drifts from the end-active expectation', () => {
    const lines = formatBucketMix([{ bucket: '1-30', loans: 5 }], 180);
    expect(lines.at(-1)).toBe('  WARNING: overdue total 5 != end-active expectation 180');
  });
});
