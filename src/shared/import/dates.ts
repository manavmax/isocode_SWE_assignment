const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

export function parseCsvDate(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value === '-' || value === '\u2013') {
    return null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [, y, m, d] = iso;
    return formatIso(Number(y), Number(m), Number(d));
  }
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value);
  if (dmy) {
    return formatIso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  }
  const dmmmy = /^(\d{1,2})[-/. ]([a-z]+)[-/. ](\d{2}|\d{4})$/i.exec(value);
  if (dmmmy) {
    const month = MONTHS[dmmmy[2]!.toLowerCase()];
    if (!month) {
      return null;
    }
    const year = Number(dmmmy[3]);
    return formatIso(year < 100 ? 2000 + year : year, month, Number(dmmmy[1]));
  }
  if (/^\d{1,6}$/.test(value)) {
    const serial = Number(value);
    if (serial < 1 || serial > 100000) {
      return null;
    }
    const ms = Date.parse('1899-12-30T00:00:00Z') + serial * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

export interface PromiseCell {
  iso: string | null;
  note: string | null;
}

export function parsePromiseCell(raw: string): PromiseCell {
  const value = raw.trim();
  if (value === '' || value === '-' || value === '\u2013') {
    return { iso: null, note: null };
  }
  const matched = extractIso(value);
  if (!matched) {
    return { iso: null, note: value };
  }
  const note = (value.slice(0, matched.start) + value.slice(matched.end)).trim();
  return { iso: matched.iso, note: note === '' ? null : note };
}

function extractIso(value: string): { iso: string; start: number; end: number } | null {
  const patterns: [RegExp, (groups: RegExpExecArray) => string | null][] = [
    [/(\d{4}-\d{2}-\d{2})/, (m) => formatIso(Number(m[1]!.slice(0, 4)), Number(m[1]!.slice(5, 7)), Number(m[1]!.slice(8, 10)))],
    [/(\d{1,2}\/\d{1,2}\/\d{4})/, (m) => {
      const parts = m[1]!.split('/');
      return formatIso(Number(parts[2]), Number(parts[1]), Number(parts[0]));
    }],
    [/(\d{1,2}-\d{1,2}-(?:\d{2}|\d{4}))/, (m) => {
      const parts = m[1]!.split('-');
      const year = Number(parts[2]);
      return formatIso(year < 100 ? 2000 + year : year, Number(parts[1]), Number(parts[0]));
    }],
    [/(\d{1,2})[-/. ]([a-z]+)[-/. ]((?:\d{2}|\d{4}))/i, (m) => {
      const month = MONTHS[m[2]!.toLowerCase()];
      if (!month) {
        return null;
      }
      const year = Number(m[3]);
      return formatIso(year < 100 ? 2000 + year : year, month, Number(m[1]));
    }]
  ];
  for (const [regex, toIso] of patterns) {
    const match = regex.exec(value);
    if (match) {
      const iso = toIso(match);
      if (iso) {
        return { iso, start: match.index, end: match.index + match[0].length };
      }
    }
  }
  return null;
}

function formatIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const ms = Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    return null;
  }
  const checked = new Date(ms);
  const iso = checked.toISOString().slice(0, 10);
  if (Number(iso.slice(0, 4)) !== year || Number(iso.slice(5, 7)) !== month || Number(iso.slice(8, 10)) !== day) {
    return null;
  }
  return iso;
}
