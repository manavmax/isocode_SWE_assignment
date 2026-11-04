import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, validateAsOf, validateUploadFile } from './uploadMeta.js';
import type { UploadFile } from './uploadMeta.js';

describe('validateAsOf', () => {
  it('defaults to today in IST when the field is missing or blank', () => {
    const { ok, asOf } = validateAsOf(undefined);
    expect(ok).toBe(true);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const blank = validateAsOf('  ');
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.asOf).toBe(asOf);
    }
  });

  it('accepts a well-formed real calendar date', () => {
    expect(validateAsOf('2026-11-04')).toEqual({ ok: true, asOf: '2026-11-04' });
  });

  it('rejects non ISO-shaped dates', () => {
    for (const bad of ['04/11/2026', '2026-2-4', '20261104', 'yesterday']) {
      expect(validateAsOf(bad).ok).toBe(false);
    }
  });

  it('rejects impossible calendar dates like 2026-02-30', () => {
    const result = validateAsOf('2026-02-30');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not a real calendar date');
    }
  });
});

describe('validateUploadFile', () => {
  const csv = (over: Partial<UploadFile>): UploadFile => ({ name: 'daily.csv', type: 'text/csv', size: 100, ...over });

  it('accepts a csv extension with a csv MIME type', () => {
    for (const type of ['text/csv', 'application/csv', 'application/vnd.ms-excel']) {
      expect(validateUploadFile(csv({ type }))).toEqual({ ok: true });
    }
  });

  it('rejects files over the 5 MB limit', () => {
    const result = validateUploadFile(csv({ size: MAX_UPLOAD_BYTES + 1 }));
    expect(result).toMatchObject({ ok: false, code: 'too_large' });
    expect(validateUploadFile(csv({ size: MAX_UPLOAD_BYTES })).ok).toBe(true);
  });

  it('rejects a non-csv extension even with a csv MIME type', () => {
    expect(validateUploadFile(csv({ name: 'daily.txt' }))).toMatchObject({ ok: false, code: 'bad_type' });
  });

  it('rejects a non-csv MIME type even with a csv extension', () => {
    expect(validateUploadFile(csv({ type: 'application/json' }))).toMatchObject({ ok: false, code: 'bad_type' });
    expect(validateUploadFile(csv({ type: '' }))).toMatchObject({ ok: false, code: 'bad_type' });
  });
});
