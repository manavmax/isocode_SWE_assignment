import { describe, expect, it } from 'vitest';
import { buildErrorsCsv, sanitizeCsvCell } from './errorsCsv.js';

describe('sanitizeCsvCell', () => {
  it('prefixes formula-looking cells with an apostrophe', () => {
    expect(sanitizeCsvCell('=cmd()')).toBe("'=cmd()");
    expect(sanitizeCsvCell('+1')).toBe("'+1");
    expect(sanitizeCsvCell('-5')).toBe("'-5");
    expect(sanitizeCsvCell('@SUM')).toBe("'@SUM");
  });

  it('leaves ordinary cells alone', () => {
    expect(sanitizeCsvCell('LN-50004')).toBe('LN-50004');
    expect(sanitizeCsvCell('')).toBe('');
  });
});

describe('buildErrorsCsv', () => {
  it('writes csv text with excel row numbers and sanitised cells', () => {
    const csv = buildErrorsCsv([
      { rowNo: 4, loanId: 'LN-50002', column: 'outstanding', code: 'bad_amount', severity: 'error', message: 'amount 6L is not a valid rupee amount' },
      { rowNo: 10, loanId: null, column: 'mobile', code: 'bad_mobile', severity: 'warning', message: ';nc examples aside, =SUM is stripped' }
    ]);
    const lines = csv.split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe('row_no,loan_id,source_column,code,severity,message');
    expect(lines[1]).toBe('4,LN-50002,outstanding,bad_amount,error,amount 6L is not a valid rupee amount');
    expect(lines[2]).toBe('10,,mobile,bad_mobile,warning,";nc examples aside, =SUM is stripped"');
  });

  it('prefixes apostrophe on a message that itself starts with a formula character', () => {
    const csv = buildErrorsCsv([
      { rowNo: 12, loanId: null, column: 'loan_id', code: 'duplicate_loan_id', severity: 'error', message: '=naughty formula' }
    ]);
    expect(csv).toContain('12,,loan_id,duplicate_loan_id,error,\'=naughty formula');
  });

  it('escapes commas inside messages with quoting', () => {
    const csv = buildErrorsCsv([
      { rowNo: 3, loanId: null, column: 'loan_id', code: 'duplicate_loan_id', severity: 'error', message: 'loan LN-1 already appeared in rows 2, 3' }
    ]);
    expect(csv).toContain('"loan LN-1 already appeared in rows 2, 3"');
  });
});
