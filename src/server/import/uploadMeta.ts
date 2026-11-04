import { z } from 'zod';
import { todayIst } from '../ist.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel']);

const asOfSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of must be YYYY-MM-DD');

export type UploadFile = { name: string; type: string; size: number };

export function validateAsOf(raw: string | undefined): { ok: true; asOf: string } | { ok: false; error: string } {
  const parsed = asOfSchema.safeParse(raw === undefined || raw.trim() === '' ? todayIst() : raw.trim());
  if (!parsed.success) {
    return { ok: false, error: 'as_of must be a YYYY-MM-DD date' };
  }
  const roundtrip = new Date(`${parsed.data}T00:00:00Z`).toISOString().slice(0, 10);
  if (roundtrip !== parsed.data) {
    return { ok: false, error: 'as_of is not a real calendar date' };
  }
  return { ok: true, asOf: parsed.data };
}

export function validateUploadFile(
  file: UploadFile
): { ok: true } | { ok: false; code: 'too_large' | 'bad_type'; error: string } {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: 'too_large', error: 'file is larger than the 5 MB limit' };
  }
  if (!file.name.toLowerCase().endsWith('.csv') || !CSV_MIME_TYPES.has(file.type)) {
    return { ok: false, code: 'bad_type', error: 'only .csv uploads with a csv MIME type are accepted' };
  }
  return { ok: true };
}
