import { describe, expect, it } from 'vitest';
import { rowErrorRows, sha256Hex } from './applyImport.js';

describe('sha256Hex', () => {
  it('matches the known sha-256 vector for "abc"', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('gives different bytes different digests so a same-date replace is detected', () => {
    const a = sha256Hex(new TextEncoder().encode('loan,amount\n1,2\n'));
    const b = sha256Hex(new TextEncoder().encode('loan,amount\n1,3\n'));
    expect(a).not.toBe(b);
  });
});

describe('rowErrorRows', () => {
  const batchId = '00000000-0000-4000-8000-00000000abcd';

  it('stores parse errors with severity error and their loan id', () => {
    const rows = rowErrorRows(
      batchId,
      [{ rowNo: 4, loanId: 'LN-50002', column: 'outstanding', code: 'bad_amount', message: 'amount 6L is not a valid rupee amount' }],
      []
    );
    expect(rows).toEqual([
      {
        batchId,
        rowNo: 4,
        loanId: 'LN-50002',
        sourceColumn: 'outstanding',
        code: 'bad_amount',
        severity: 'error',
        message: 'amount 6L is not a valid rupee amount'
      }
    ]);
  });

  it('stores parse warnings with severity warning, never error', () => {
    const rows = rowErrorRows(
      batchId,
      [],
      [{ rowNo: 7, loanId: 'LN-50005', column: 'mobile', code: 'bad_mobile', message: 'mobile 9.87E+9 is not 10 digits starting 6-9' }]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('warning');
    expect(rows[0]!.code).toBe('bad_mobile');
  });

  it('nulls loan id when the issue carries none (missing loan id cell)', () => {
    const rows = rowErrorRows(batchId, [{ rowNo: 3, column: 'loan_id', code: 'required_cell_missing', message: 'loan id is required' }], []);
    expect(rows[0]!.loanId).toBeNull();
  });

  it('keeps errors before warnings in file order', () => {
    const rows = rowErrorRows(
      batchId,
      [{ rowNo: 4, loanId: 'LN-2', column: 'outstanding', code: 'bad_amount', message: 'e1' }],
      [{ rowNo: 3, loanId: 'LN-1', column: 'mobile', code: 'bad_mobile', message: 'w1' }]
    );
    expect(rows.map((row) => row.severity)).toEqual(['error', 'warning']);
  });
});
