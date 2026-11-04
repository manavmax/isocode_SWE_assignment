export interface ErrorRow {
  rowNo: number;
  loanId?: string | null;
  column: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function buildErrorsCsv(rows: readonly ErrorRow[]): string {
  const header = 'row_no,loan_id,source_column,code,severity,message';
  const lines = rows.map(csvLine);
  return [header, ...lines].join('\n') + '\n';
}

function csvLine(row: ErrorRow): string {
  const cells = [String(row.rowNo), row.loanId ?? '', row.column, row.code, row.severity, row.message].map(sanitizeCsvCell);
  if (row.message.includes(',')) {
    cells[5] = `"${cells[5]}"`;
  }
  if (row.message.includes('\n')) {
    cells[5] = `"${cells[5]}"`;
  }
  return cells.join(',');
}
