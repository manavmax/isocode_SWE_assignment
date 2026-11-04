import { describe, expect, it } from 'vitest';
import { CANONICAL_COLUMNS, mapHeaders, normaliseHeader, REQUIRED_COLUMNS } from './headers.js';

const REQUIRED: readonly string[] = REQUIRED_COLUMNS;

describe('normaliseHeader', () => {
  it('lowercases and maps non-alphanumerics to underscore', () => {
    expect(normaliseHeader('Loan A/c No.')).toBe('loan_a_c_no');
    expect(normaliseHeader('Principal O/s')).toBe('principal_o_s');
    expect(normaliseHeader('Pin Code')).toBe('pin_code');
    expect(normaliseHeader('  DPD ')).toBe('dpd');
  });
});

describe('mapHeaders', () => {
  it('maps the alias families in the spec to canonical columns', () => {
    const headers = ['LAN', 'Borrower', 'POS', 'DPD', 'Pin Code', 'Branch'];
    const map = mapHeaders(headers);
    expect(map.cols.loan_id).toBe(0);
    expect(map.cols.borrower_name).toBe(1);
    expect(map.cols.outstanding).toBe(2);
    expect(map.cols.dpd).toBe(3);
    expect(map.cols.pincode).toBe(4);
    expect(map.cols.branch).toBe(5);
    expect(map.missing).toEqual([]);
  });

  it('maps "Loan A/c No" and "Loan ID" and "LAN" all to loan_id', () => {
    expect(mapHeaders(['Loan ID']).cols.loan_id).toBe(0);
    expect(mapHeaders(['Loan A/c No']).cols.loan_id).toBe(0);
    expect(mapHeaders(['LAN']).cols.loan_id).toBe(0);
  });

  it('separates outstanding family and arrears into outstanding and overdue_amount', () => {
    const map = mapHeaders(['Principal O/s', 'Arrears']);
    expect(map.cols.outstanding).toBe(0);
    expect(map.cols.overdue_amount).toBe(1);
  });

  it('maps optional aliases when present', () => {
    const map = mapHeaders([...REQUIRED, 'Business Name', 'Mobile No', 'Promise Date', 'Officer Name', 'Last Due Date']);
    expect(map.cols.business_name).toBe(6);
    expect(map.cols.mobile).toBe(7);
    expect(map.cols.promise_date).toBe(8);
    expect(map.cols.officer).toBe(9);
    expect(map.cols.last_due_date).toBe(10);
    expect(map.missing).toEqual([]);
  });

  it('keeps the first occurrence when duplicate canonical columns appear', () => {
    const map = mapHeaders(['Outstanding', 'POS']);
    expect(map.cols.outstanding).toBe(0);
  });

  it('rejects files missing required columns and suggests nearest aliases', () => {
    const map = mapHeaders(['Loan ID', 'Borrower', 'Outstanding', 'DPD', 'Pincde', 'Brach']);
    expect(map.missing).toContain('pincode');
    expect(map.missing).toContain('branch');
    expect(map.suggestions.pincode).toBe('Pincde');
    expect(map.suggestions.branch).toBe('Brach');
  });

  it('reports unmapped headers', () => {
    const map = mapHeaders(['Extra Column', ...REQUIRED]);
    expect(map.unmapped.map((entry) => entry.raw)).toEqual(['Extra Column']);
  });

  it('covers all required canonical columns in the alias table', () => {
    const covered = Object.keys(CANONICAL_COLUMNS);
    for (const column of REQUIRED) {
      expect(covered).toContain(column);
    }
  });
});
