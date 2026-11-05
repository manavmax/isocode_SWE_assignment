import { describe, expect, it } from 'vitest';
import { CSV_HEADERS, csvEscape, renderCsv, filenameFor } from './csvWriter.js';

describe('csvEscape', () => {
  it('quotes cells with commas, quotes and newlines, and doubles inner quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape('')).toBe('');
  });
});

describe('renderCsv', () => {
  it('writes the canonical header row and data rows with escaped cells', () => {
    const csv = renderCsv(
      CSV_HEADERS.slice(0, 3),
      [
        ['LN-1', 'A B', 'Firm, Traders'],
        ['LN-2', 'C D', '']
      ]
    );
    const lines = csv.replace(/\r?\n$/, '').split('\n');
    expect(lines[0]).toBe('loan_id,borrower_name,business_name');
    expect(lines[1]).toBe('LN-1,A B,"Firm, Traders"');
    expect(lines[2]).toBe('LN-2,C D,');
  });

  it('keeps empty trailing cells so the column count stays aligned', () => {
    const csv = renderCsv(['a', 'b'], [['x', ''], ['y', 'z']]);
    const lines = csv.replace(/\n$/, '').split('\n');
    expect(lines.map((line) => line.split(',').length)).toEqual([2, 2, 2]);
  });
});

describe('filenameFor', () => {
  it('formats overdue_<date>.csv per file-day', () => {
    expect(filenameFor('2026-11-05')).toBe('overdue_2026-11-05.csv');
  });
});

describe('CSV_HEADERS', () => {
  it('is exactly the importer-required columns plus the optional ones the seed emits', () => {
    expect(CSV_HEADERS).toHaveLength(14);
    for (const required of ['loan_id', 'borrower_name', 'outstanding', 'dpd', 'pincode', 'branch']) {
      expect(CSV_HEADERS).toContain(required);
    }
    expect(CSV_HEADERS).not.toContain('promise_date'); // part 2 (events/promises) stays out of the file contract
    expect(CSV_HEADERS).not.toContain('officer'); // A18/A25 assignment is territory-driven, the Officer column is bookkeeping
    expect(CSV_HEADERS).not.toContain('last_due_date');
  });
});
