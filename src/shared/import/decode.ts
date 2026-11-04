export type SniffedDelimiter = ',' | ';' | '\t' | '|';

export interface DecodedCsv {
  text: string;
  delimiter: SniffedDelimiter;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp1252';
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function decodeBytes(bytes: Uint8Array): DecodedCsv {
  if (hasBom(bytes, UTF8_BOM)) {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    return finish(text, 'utf-8', sniffDelimiter(text));
  }
  if (hasBom(bytes, [0xff, 0xfe])) {
    const text = new TextDecoder('utf-16').decode(bytes.subarray(2));
    return finish(stripBomChar(text), 'utf-16le', sniffDelimiter(text));
  }
  if (hasBom(bytes, [0xfe, 0xff])) {
    const text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    return finish(stripBomChar(text), 'utf-16be', sniffDelimiter(text));
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return finish(text, 'utf-8', sniffDelimiter(text));
  } catch {
    const text = new TextDecoder('windows-1252').decode(bytes);
    return finish(text, 'cp1252', sniffDelimiter(text));
  }
}

function hasBom(bytes: Uint8Array, bom: number[]): boolean {
  return bom.every((byte, index) => bytes[index] === byte);
}

function stripBomChar(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function finish(text: string, encoding: DecodedCsv['encoding'], delimiter: SniffedDelimiter): DecodedCsv {
  const normalised = text.normalize('NFC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');
  return { text: normalised, delimiter, encoding };
}

const CANDIDATES: SniffedDelimiter[] = [',', ';', '\t', '|'];

export function sniffDelimiter(text: string): SniffedDelimiter {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
  let best: SniffedDelimiter = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? '';
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}
