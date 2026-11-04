import { describe, expect, it } from 'vitest';
import { decodeBytes } from './decode.js';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withBom(bytes: Uint8Array, bom: number[]): Uint8Array {
  const out = new Uint8Array(bom.length + bytes.length);
  out.set(bom, 0);
  out.set(bytes, bom.length);
  return out;
}

describe('decodeBytes', () => {
  it('decodes plain utf-8 with the sniffed delimiter', () => {
    const decoded = decodeBytes(utf8('a,b,c\n1,2,3'));
    expect(decoded.text).toBe('a,b,c\n1,2,3');
    expect(decoded.delimiter).toBe(',');
    expect(decoded.encoding).toBe('utf-8');
  });

  it('strips a utf-8 bom', () => {
    const decoded = decodeBytes(withBom(utf8('x,y'), [0xef, 0xbb, 0xbf]));
    expect(decoded.text).toBe('x,y');
    expect(decoded.encoding).toBe('utf-8');
  });

  it('decodes utf-16le bom files', () => {
    const body = 'Loan,DPD\nLN-1,10';
    const bytes = new Uint8Array(2 + body.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < body.length; i += 1) {
      const code = body.charCodeAt(i);
      bytes[2 + i * 2] = code & 0xff;
      bytes[3 + i * 2] = code >> 8;
    }
    const decoded = decodeBytes(bytes);
    expect(decoded.text).toBe(body);
    expect(decoded.encoding).toBe('utf-16le');
    expect(decoded.delimiter).toBe(',');
  });

  it('decodes utf-16be bom files', () => {
    const body = 'a;b';
    const bytes = new Uint8Array(2 + body.length * 2);
    bytes[0] = 0xfe;
    bytes[1] = 0xff;
    for (let i = 0; i < body.length; i += 1) {
      const code = body.charCodeAt(i);
      bytes[2 + i * 2] = code >> 8;
      bytes[3 + i * 2] = code & 0xff;
    }
    const decoded = decodeBytes(bytes);
    expect(decoded.text).toBe(body);
    expect(decoded.encoding).toBe('utf-16be');
  });

  it('falls back to cp1252 for bytes that are not valid utf-8', () => {
    // "Rémunéré" encoded in cp1252: 0x92 = smart quote, 0xe9 = é.
    const decoded = decodeBytes(new Uint8Array([0x52, 0x92, 0x6d, 0x75, 0x6e, 0xe9, 0x72, 0xe9]));
    expect(decoded.encoding).toBe('cp1252');
    expect(decoded.text).toBe('R\u2019mun\u00e9r\u00e9');
  });

  it('sniffs semicolon delimiter', () => {
    expect(decodeBytes(utf8('a;b;c\n1;2;3')).delimiter).toBe(';');
  });

  it('sniffs tab delimiter', () => {
    expect(decodeBytes(utf8('a\tb\n1\t2')).delimiter).toBe('\t');
  });

  it('sniffs pipe delimiter', () => {
    expect(decodeBytes(utf8('a|b\n1|2')).delimiter).toBe('|');
  });

  it('sniffs comma when delimiters are interleaved with quoted commas', () => {
    const decoded = decodeBytes(utf8('"Khan, Farida";DPD\n"10";15'));
    expect(decoded.delimiter).toBe(';');
  });

  it('defaults to comma when no candidate delimiter appears', () => {
    expect(decodeBytes(utf8('single-column\nrow')).delimiter).toBe(',');
  });

  it('nfc-normalises composed accents', () => {
    const raw = utf8('name,nfd\nD\u0065\u0301cu,1');
    const decoded = decodeBytes(raw);
    expect(decoded.text).toContain('D\u00e9cu');
  });

  it('strips zero-width characters', () => {
    const decoded = decodeBytes(utf8('id,amt\nLN\u200b-9,10\u2060'));
    expect(decoded.text).toBe('id,amt\nLN-9,10');
  });
});
