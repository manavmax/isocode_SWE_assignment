import { describe, expect, it } from 'vitest';
import { mapHeaders } from './headers.js';
import { validateRow } from './validateRow.js';

const HEADERS = [
  'Loan ID',
  'Borrower',
  'POS',
  'DPD',
  'Pin Code',
  'Branch',
  'Business Name',
  'Mobile',
  'Alt Mobile',
  'Address',
  'Arrears',
  'Promise Date'
];

const BASE = {
  branches: new Set(['ujjain', 'dewas'])
};

function row(cells: Partial<Record<string, string>>, rowNo = 2) {
  const map = mapHeaders(HEADERS);
  const full = HEADERS.map((header) => cells[header.toUpperCase()] ?? '');
  return { map, full, rowNo };
}

function validate(cells: Partial<Record<string, string>>, rowNo = 2, seen = new Set<string>(), territoryPincodes?: Set<string>) {
  const { map, full, rowNo: n } = row(cells, rowNo);
  return validateRow(full, map.cols, n, { ...BASE, territoryPincodes, seenLoanIds: seen });
}

describe('validateRow', () => {
  it('parses a fully valid row with money in paise and promise parts', () => {
    const result = validate({
      'LOAN ID': 'LN-10293',
      BORROWER: 'Ramesh Sharma',
      POS: 'Rs. 6,40,000/-',
      DPD: '12',
      'PIN CODE': '452001',
      BRANCH: 'Ujjain',
      'PROMISE DATE': '2026-11-05'
    });
    expect(result.status).toBe('ok');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.loan?.outstanding).toBe(64000000);
    expect(result.loan?.dpd).toBe(12);
    expect(result.loan?.branch).toBe('Ujjain');
    expect(result.loan?.promiseDate).toBe('2026-11-05');
    expect(result.loan?.promiseNote).toBeNull();
  });

  it('keeps first duplicate loan_id and raises a duplicate error on later rows', () => {
    const seen = new Set<string>();
    const first = validate({ 'LOAN ID': 'LN-1', BORROWER: 'A', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' }, 2, seen);
    expect(first.status).toBe('ok');
    const second = validate({ 'LOAN ID': 'LN-1', BORROWER: 'A', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' }, 3, seen);
    expect(second.status).toBe('dropped');
    expect(second.errors.map((error) => error.code)).toContain('duplicate_loan_id');
  });

  it('rejects malformed pincode with error', () => {
    const result = validate({ 'LOAN ID': 'LN-2', BORROWER: 'B', POS: '500', DPD: '5', 'PIN CODE': '4520', BRANCH: 'Ujjain' });
    expect(result.errors.map((error) => error.code)).toContain('bad_pincode');
  });

  it('rejects bad dpd with error', () => {
    const bad = validate({ 'LOAN ID': 'LN-3', BORROWER: 'C', POS: '500', DPD: 'abc', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(bad.errors.map((error) => error.code)).toContain('bad_dpd');
    const negative = validate({ 'LOAN ID': 'LN-4', BORROWER: 'D', POS: '500', DPD: '-3', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(negative.errors.map((error) => error.code)).toContain('bad_dpd');
  });

  it('rejects outstanding and optional amounts that fail paise parsing', () => {
    const badPos = validate({ 'LOAN ID': 'LN-5', BORROWER: 'E', POS: '6L', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(badPos.errors.map((error) => error.code)).toContain('bad_amount');
    const badOverdue = validate(
      { 'LOAN ID': 'LN-6', BORROWER: 'F', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain', ARREARS: '1.2Cr' },
    );
    expect(badOverdue.errors.map((error) => error.code)).toContain('bad_amount');
  });

  it('rejects unknown branch with error', () => {
    const result = validate({ 'LOAN ID': 'LN-7', BORROWER: 'G', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Indore-Rural' });
    expect(result.errors.map((error) => error.code)).toContain('unknown_branch');
  });

  it('warns on malformed mobile when a valid alt mobile exists', () => {
    const result = validate(
      { 'LOAN ID': 'LN-8', BORROWER: 'H', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain', MOBILE: '9.87E+9', 'ALT MOBILE': '8765432101' },
    );
    expect(result.warnings.map((warning) => warning.code)).toEqual(['bad_mobile']);
    expect(result.status).toBe('ok');
  });

  it('warns on malformed mobile when address is present', () => {
    const result = validate(
      { 'LOAN ID': 'LN-9', BORROWER: 'I', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain', MOBILE: '1234', ADDRESS: '12 Main' },
    );
    expect(result.warnings.map((warning) => warning.code)).toEqual(['bad_mobile']);
  });

  it('errors when mobile invalid and no usable phone or address', () => {
    const result = validate({ 'LOAN ID': 'LN-10', BORROWER: 'J', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain', MOBILE: '9.87E+9' });
    expect(result.errors.map((error) => error.code)).toContain('no_contact_info');
  });

  it('skips dpd 0 rows with a warning', () => {
    const result = validate({ 'LOAN ID': 'LN-11', BORROWER: 'K', POS: '500', DPD: '0', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(result.status).toBe('skipped');
    expect(result.warnings.map((warning) => warning.code)).toContain('dpd_zero');
    expect(result.loan).toBeNull();
  });

  it('imports dpd above 90 flagged NPA', () => {
    const result = validate({ 'LOAN ID': 'LN-12', BORROWER: 'L', POS: '500', DPD: '95', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(result.status).toBe('ok');
    expect(result.npa).toBe(true);
    expect(result.loan?.npa).toBe(true);
  });

  it('warns when pincode is absent from the provided territory map', () => {
    const result = validate(
      { 'LOAN ID': 'LN-13', BORROWER: 'M', POS: '500', DPD: '5', 'PIN CODE': '999999', BRANCH: 'Ujjain' },
      2,
      new Set(),
      new Set(['452001'])
    );
    expect(result.warnings.map((warning) => warning.code)).toContain('pincode_not_in_territory');
  });

  it('does not warn on territory when no map is provided', () => {
    const result = validate({ 'LOAN ID': 'LN-14', BORROWER: 'N', POS: '500', DPD: '5', 'PIN CODE': '999999', BRANCH: 'Ujjain' });
    expect(result.warnings.map((warning) => warning.code)).not.toContain('pincode_not_in_territory');
  });

  it('flags missing required cells as errors', () => {
    const noBorrower = validate({ 'LOAN ID': 'LN-15', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(noBorrower.errors.map((error) => error.code)).toContain('required_cell_missing');
    const noLoanId = validate({ BORROWER: 'O', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(noLoanId.errors.map((error) => error.code)).toContain('required_cell_missing');
  });

  it('reports excel row numbers with the header as row 1', () => {
    const result = validate(
      { 'LOAN ID': 'LN-16', BORROWER: 'P', POS: '500', DPD: '5', 'PIN CODE': '4520', BRANCH: 'Ujjain' },
      7
    );
    expect(result.errors[0]!.rowNo).toBe(7);
  });

  it('carries the loan id on issues from dropped rows so errors.csv can name the loan', () => {
    const badAmount = validate({ 'LOAN ID': 'LN-17', BORROWER: 'Q', POS: '6L', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' }, 9);
    expect(badAmount.status).toBe('dropped');
    expect(badAmount.errors.every((error) => error.loanId === 'LN-17')).toBe(true);

    const seen = new Set<string>();
    validate({ 'LOAN ID': 'LN-18', BORROWER: 'R', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' }, 2, seen);
    const duplicate = validate({ 'LOAN ID': 'LN-18', BORROWER: 'R', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' }, 3, seen);
    expect(duplicate.errors.find((error) => error.code === 'duplicate_loan_id')?.loanId).toBe('LN-18');
  });

  it('leaves loanId undefined on issues from rows with no loan id cell', () => {
    const result = validate({ BORROWER: 'S', POS: '500', DPD: '5', 'PIN CODE': '452001', BRANCH: 'Ujjain' });
    expect(result.errors.map((error) => error.code)).toEqual(['required_cell_missing']);
    expect(result.errors.map((error) => error.loanId)).toEqual([undefined]);
  });
});
