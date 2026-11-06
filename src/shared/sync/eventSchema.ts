/**
 * Client-submitted contact event (SPEC 5/6): the wire schema for what the
 * outbox flush sends inside POST /api/events/batch. Two invariants are load
 * bearing:
 * - `synced_at` NEVER appears here. The schema is strict, so a client trying
 *   to set the server's clock column fails validation outright (SPEC 6), and
 *   the insert path also sets syncedAt itself, so the column can never be
 *   sourced from a payload.
 * - `outcome` reuses CONTACT_OUTCOMES from src/shared/types.ts — one vocab-
 *   ulary for Drizzle, validation and the client. dispute/dialled joined it
 *   for this work (assumption A50; the column is text, so no DB migration).
 */
import { z } from 'zod';
import { contactOutcomeSchema, gpsStatusSchema, contactKindSchema, type GpsStatus } from '../types.js';

/** SPEC 6: single-flight batches of 20. */
export const MAX_EVENT_BATCH = 20;
/** Notes are free text; capped so a rogue client cannot park megabytes. */
export const EVENT_NOTE_MAX_CHARS = 1000;
/** Device UTC offset: minutes EAST of GMT, positive (IST = +330). Bounds
 * follow ISO 8601 zone offsets ±14:00. */
export const DEVICE_TZ_OFFSET_MAX_MIN = 840;
/** Skew estimates are only meaningful within a day; signed (server ahead is
 * positive per the SPEC 7 skew = serverNow − client formula). */
export const SKEW_ESTIMATE_MAX_MS = 24 * 60 * 60_000;

/** Keys the server owns outright; a payload carrying any of them is a
 * protocol error even before strictness rejects it. */
export const SERVER_EXCLUDED_FIELDS = ['synced_at'] as const;

/** Only these GPS statuses are allowed to claim a real fix. */
export const GPS_STATUS_REQUIRED_FOR = ['ok', 'low_accuracy'] as const;

/** Type guard over the same pair, so the refinement stays assignment-proof. */
function isFixStatus(status: GpsStatus | null | undefined): boolean {
  return status === 'ok' || status === 'low_accuracy';
}

export const contactEventInputSchema = z
  .object({
    id: z.uuid(),
    loan_id: z.string().min(1),
    kind: contactKindSchema,
    outcome: contactOutcomeSchema,
    attempted_at_device: z.iso.datetime({ offset: true }),
    device_tz_offset_min: z
      .number()
      .int()
      .min(-DEVICE_TZ_OFFSET_MAX_MIN)
      .max(DEVICE_TZ_OFFSET_MAX_MIN),
    /** Present only when the client has measured skew since its last sync
     * response; null/absent means "unknown" and the server grades the stamp
     * time_confidence = low. */
    skew_estimate_ms: z
      .number()
      .int()
      .min(-SKEW_ESTIMATE_MAX_MS)
      .max(SKEW_ESTIMATE_MAX_MS)
      .nullish(),
    /** GPS only at discrete events (SPEC 7): optional block, never required,
     * never fabricated — a reported fix must carry BOTH coordinates. */
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    accuracy_m: z.number().int().min(1).max(100_000).nullish(),
    gps_status: gpsStatusSchema.nullish(),
    note: z.string().max(EVENT_NOTE_MAX_CHARS).nullish(),
    /** Append-only corrections: a new event may point at exactly one older
     * event it corrects, never at itself. */
    corrects_event_id: z.uuid().nullish(),
    /** Only the promise outcome carries the promise payload. */
    promised_date: z.iso.date().nullish(),
    promised_amount: z.number().int().positive().nullish()
  })
  .strict()
  .superRefine((value, ctx) => {
    // The never-ever field: reject loudly so the offline outbox can surface a
    // visible Retry/Discard instead of shipping the server's clock by accide-
    // dent (SPEC 6: never accept a client-supplied synced_at).
    for (const forbidden of SERVER_EXCLUDED_FIELDS) {
      if (forbidden === 'synced_at' && 'synced_at' in value) {
        ctx.addIssue({
          code: 'custom',
          path: [forbidden],
          message: 'synced_at is set by the server and can never be supplied by the client'
        });
      } else if (forbidden !== 'synced_at' && forbidden in value) {
        ctx.addIssue({ code: 'custom', path: [forbidden], message: `${forbidden} is a server-owned field` });
      }
    }

    if (value.corrects_event_id && value.corrects_event_id === value.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['corrects_event_id'],
        message: 'an event can never correct itself'
      });
    }

    // Partial fixes are fabricated precision: require both coordinates.
    const hasLat = value.lat != null;
    const hasLng = value.lng != null;
    if (hasLat !== hasLng) {
      ctx.addIssue({
        code: 'custom',
        path: [hasLat ? 'lat' : 'lng'],
        message: 'lat and lng are stored together; half a position is not a position'
      });
    } else if (hasLat && value.gps_status && !isFixStatus(value.gps_status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gps_status'],
        message: `coordinates may only be reported with a real fix (${GPS_STATUS_REQUIRED_FOR.join('/')})`
      });
    }
    // ...and a status claiming a fix must actually carry one.
    if (!hasLat && isFixStatus(value.gps_status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gps_status'],
        message: 'a reported fix (ok/low_accuracy) must include lat and lng'
      });
    }

    const isPromise = value.outcome === 'promise_to_pay';
    if (isPromise) {
      if (!value.promised_date) {
        ctx.addIssue({ code: 'custom', path: ['promised_date'], message: 'promised_date is required for a promise outcome' });
      }
      if (value.promised_amount == null) {
        ctx.addIssue({ code: 'custom', path: ['promised_amount'], message: 'promised_amount is required for a promise outcome' });
      }
    } else {
      if (value.promised_date != null) {
        ctx.addIssue({ code: 'custom', path: ['promised_date'], message: 'promised_date belongs to the promise_to_pay outcome only' });
      }
      if (value.promised_amount != null) {
        ctx.addIssue({ code: 'custom', path: ['promised_amount'], message: 'promised_amount belongs to the promise_to_pay outcome only' });
      }
    }
  });

export type ContactEventInput = z.output<typeof contactEventInputSchema>;

/** Envelope zoomed out from the items: 1..20 raw entries. Items are graded
 * one by one so a single bad event cannot reject the whole queue (SPEC 6). */
export const contactEventBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENT_BATCH)
});

/** Merge helper for tests: a minimal valid event overlaid with overrides. */
export function validContactEventInput(overrides: Partial<ContactEventInput> = {}): ContactEventInput {
  return {
    id: overrides.id ?? '0b9a2f42-8f6f-4bc8-9d3e-1f2a3c4d5e6f',
    loan_id: overrides.loan_id ?? 'LN-10001',
    kind: overrides.kind ?? 'CALL',
    outcome: overrides.outcome ?? 'paid',
    attempted_at_device: overrides.attempted_at_device ?? '2026-11-06T05:30:00.000Z',
    device_tz_offset_min: overrides.device_tz_offset_min ?? 330,
    ...overrides
  };
}
