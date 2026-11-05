/**
 * CSV rendering for the seed's daily files (SPEC 14). Pure string building —
 * the exact same bytes go to disk (gitignored data/generated/) and into the
 * real importer. The header is the canonical column set of
 * src/shared/import/headers.ts: the six REQUIRED columns plus the optional
 * business/mobile/address/locality/product/overdue/emi columns. `officer`,
 * `promise_date` and `last_due_date` are intentionally absent: assignment is
 * territory-driven (A18/A25 — the sample file's Officer column was
 * bookkeeping only) and promises arrive in the second seed part.
 */

export const CSV_HEADERS = [
  'loan_id',
  'borrower_name',
  'business_name',
  'mobile',
  'alt_mobile',
  'address',
  'locality',
  'product',
  'outstanding',
  'overdue_amount',
  'emi_amount',
  'dpd',
  'pincode',
  'branch'
] as const;

export function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

/** Header row + data rows, POSIX newlines, trailing newline. The parser side
 *  (src/shared/import/decode.ts) is newline-dialect agnostic either way. */
export function renderCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers.map(csvEscape).join(','), ...rows.map((row) => row.map(csvEscape).join(','))];
  return `${lines.join('\n')}\n`;
}

export function filenameFor(date: string): string {
  return `overdue_${date}.csv`;
}
