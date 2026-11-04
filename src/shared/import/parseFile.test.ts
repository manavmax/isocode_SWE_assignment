import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv } from './parseFile.js';

const ENCODER = new TextEncoder();
const BRANCHES = new Set(['ujjain', 'dewas', 'indore']);

function fromText(text: string) {
  return parseCsv(ENCODER.encode(text), { branches: BRANCHES });
}

function fromFile(path: string) {
  return parseCsv(readFileSync(path), { branches: BRANCHES });
}

describe('parseCsv', () => {
  it('parses the three-loan brief sample end to end', () => {
    const report = fromFile('data/sample_overdue.csv');
    expect(report.abort).toBeNull();
    expect(report.delimiter).toBe(',');
    expect(report.totalRows).toBe(3);
    expect(report.rows).toHaveLength(3);
    expect(report.imported).toBe(3);
    expect(report.dropped).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('type-casts the first brief loan with money in paise and the brief exact values', () => {
    const report = fromFile('data/sample_overdue.csv');
    const first = report.rows[0]!;
    expect(first.loanId).toBe('LN-10293');
    expect(first.outstanding).toBe(64000000);
    expect(first.dpd).toBe(12);
    expect(first.pincode).toBe('457001');
    expect(first.branch).toBe('Ujjain');
    expect(first.businessName).toBe('Sharma Kirana');
    expect(first.promiseDate).toBe('2026-11-05');
    expect(first.promiseNote).toBeNull();
    expect(first.officer).toBe('Rahul Chouhan');
    expect(first.npa).toBe(false);
  });

  it('reads dash as no promise and the third loan as a broken promise', () => {
    const report = fromFile('data/sample_overdue.csv');
    expect(report.rows[1]!.promiseDate).toBeNull();
    expect(report.rows[1]!.promiseNote).toBeNull();
    expect(report.rows[2]!.promiseDate).toBe('2026-10-31');
    expect(report.rows[2]!.promiseNote).toBe('(broken)');
  });

  it('accepts bad_rows.csv partially: 4 error rows under the 20 percent abort', () => {
    const report = fromFile('data/bad_rows.csv');
    expect(report.totalRows).toBe(46);
    expect(report.dropped).toBe(4);
    expect(report.imported).toBe(42);
    expect(report.abort).toBeNull();
  });

  it('aborts abort_rows.csv on error rate over 20 percent', () => {
    const report = fromFile('data/abort_rows.csv');
    expect(report.totalRows).toBe(5);
    expect(report.dropped).toBe(3);
    expect(report.imported).toBe(2);
    expect(report.abort?.code).toBe('error_rate');
    expect(report.abort?.message).toContain('60%');
  });

  it('flags the bad_rows fixtures exactly: duplicates, three amounts, sci mobile', () => {
    const report = fromFile('data/bad_rows.csv');
    const errorRowNos = [...new Set(report.errors.map((error) => error.rowNo))];
    expect(errorRowNos).toEqual([3, 4, 5, 6]);
    expect(report.errors.map((error) => error.code)).toContain('duplicate_loan_id');
    expect(report.errors.filter((error) => error.code === 'bad_amount')).toHaveLength(3);
    expect(report.warnings.map((warning) => warning.code)).toEqual(['bad_mobile']);
    expect(report.rows[0]?.loanId).toBe('LN-50001');
    expect(report.rows[0]?.outstanding).toBe(12000000);
    expect(report.rows[1]?.loanId).toBe('LN-50005');
    expect(report.rows[1]?.outstanding).toBe(6600000);
  });

  it('aborts files with zero data rows', () => {
    const report = fromText('Loan ID,Borrower,POS,DPD,Pin Code,Branch\n');
    expect(report.abort?.code).toBe('empty');
    expect(report.rows).toHaveLength(0);
  });

  it('aborts files missing required columns and suggests the nearest alias', () => {
    const report = fromText(
      'Loan ID,Borrower,Outstanding,DPD,Pincde,Brach\nLN-1,ABC Trading,500,12,452001,Ujjain'
    );
    expect(report.abort?.code).toBe('missing_columns');
    expect(report.abort?.message).toContain('Pincde');
    expect(report.rows).toHaveLength(0);
  });

  it('keeps the first of duplicate loan ids and counts the later row as dropped', () => {
    const text = [
      'Loan ID,Borrower,POS,DPD,Pin Code,Branch',
      'LN-9,ABC Trading,500,12,452001,Ujjain',
      'LN-9,ABC Trading,500,12,452001,Ujjain',
      ...Array.from({ length: 8 }, (_, i) => `LN-1${i},Zeta Stores,700,${i + 3},452001,Ujjain`)
    ].join('\n');
    const report = fromText(text);
    expect(report.totalRows).toBe(10);
    expect(report.imported).toBe(9);
    expect(report.dropped).toBe(1);
    expect(report.errors.some((error) => error.code === 'duplicate_loan_id')).toBe(true);
    expect(report.abort).toBeNull();
  });

  it('handles quoted semicolon rows with commas inside cells', () => {
    const report = fromText(
      'Loan ID;Borrower;POS;DPD;Pin Code;Branch\nLN-11;"Khan, Farida";1,500;12;452001;Ujjain'
    );
    expect(report.delimiter).toBe(';');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.borrowerName).toBe('Khan, Farida');
    expect(report.rows[0]!.outstanding).toBe(150000);
  });

  it('counts dpd 0 rows as skipped warnings and keeps abort null', () => {
    const report = fromText(
      [
        'Loan ID,Borrower,POS,DPD,Pin Code,Branch',
        'LN-12,ABC Trading,500,12,452001,Ujjain',
        'LN-13,Zeta Stores,700,0,452001,Ujjain'
      ].join('\n')
    );
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.warnings.map((warning) => warning.code)).toContain('dpd_zero');
    expect(report.abort).toBeNull();
  });
});
