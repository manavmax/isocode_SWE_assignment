import { decodeBytes } from './decode.js';
import type { SniffedDelimiter } from './decode.js';
import { mapHeaders } from './headers.js';
import type { HeaderMap } from './headers.js';
import { validateRow } from './validateRow.js';
import type { ImportLoan, RowIssue } from './validateRow.js';

export interface ParseCtx {
  branches: ReadonlySet<string>;
  territoryPincodes?: ReadonlySet<string>;
}

export interface ImportAbort {
  code: 'missing_columns' | 'empty' | 'error_rate';
  message: string;
}

export interface ParseReport {
  delimiter: SniffedDelimiter;
  encoding: string;
  headers: string[];
  mapping: HeaderMap;
  rows: ImportLoan[];
  totalRows: number;
  imported: number;
  dropped: number;
  skipped: number;
  errors: RowIssue[];
  warnings: RowIssue[];
  abort: ImportAbort | null;
}

export function parseCsv(bytes: Uint8Array, ctx: ParseCtx): ParseReport {
  const decoded = decodeBytes(bytes);
  const lines = splitLines(decoded.text);
  const headers = splitCsvLine(lines[0] ?? '', decoded.delimiter);
  const mapping = mapHeaders(headers);

  const base: ParseReport = {
    delimiter: decoded.delimiter,
    encoding: decoded.encoding,
    headers,
    mapping,
    rows: [],
    totalRows: 0,
    imported: 0,
    dropped: 0,
    skipped: 0,
    errors: [],
    warnings: [],
    abort: null
  };

  if (mapping.missing.length > 0) {
    const described = mapping.missing
      .map((column) => (mapping.suggestions[column] ? `${column} (nearest header: "${mapping.suggestions[column]}")` : column))
      .join(', ');
    base.abort = { code: 'missing_columns', message: `missing required columns: ${described}` };
    return base;
  }

  const dataLines = lines.slice(1).filter((line) => line.trim() !== '');
  if (dataLines.length === 0) {
    base.abort = { code: 'empty', message: 'no data rows after the header' };
    return base;
  }

  const seen = new Set<string>();
  const rows: ImportLoan[] = [];
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  let imported = 0;
  let dropped = 0;
  let skipped = 0;

  dataLines.forEach((line, index) => {
    const rowNo = index + 2;
    const cells = splitCsvLine(line, decoded.delimiter);
    const result = validateRow(cells, mapping.cols, rowNo, {
      branches: ctx.branches,
      territoryPincodes: ctx.territoryPincodes,
      seenLoanIds: seen
    });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.loan) {
      rows.push(result.loan);
      imported += 1;
    }
    if (result.status === 'dropped') {
      dropped += 1;
    }
    if (result.status === 'skipped') {
      skipped += 1;
    }
  });

  const abort: ImportAbort | null =
    errors.length === 0
      ? null
      : dropped / dataLines.length > 0.2
        ? {
          code: 'error_rate',
          message: `${dropped} of ${dataLines.length} rows had errors (${Math.round((dropped / dataLines.length) * 100)}%)`
        }
        : null;

  return { ...base, rows, totalRows: dataLines.length, imported, dropped, skipped, errors, warnings, abort };
}

export function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}
