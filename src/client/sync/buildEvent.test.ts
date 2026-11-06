/**
 * Event construction tests (prompt 10b): every event carries a client UUID,
 * the raw device stamp, the device tz offset and the LATEST stored skew
 * (SPEC 7); the client-side promise validation wraps the SHARED rules.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEventSync, buildContactEvent, validatePromiseClient } from './buildEvent.js';
import { db, setMeta, META_KEYS } from '../dexie/db.js';
import type { GpsState } from '../gps.js';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  await db.delete();
});

const NO_GPS: GpsState = { fix: null, rawStatus: 'not_requested' };

describe('buildEventSync / buildContactEvent', () => {
  it('stamps the device clock (raw), the device tz offset and a client UUID', () => {
    const attemptedAtMs = Date.parse('2026-11-06T06:30:00.000Z');
    const event = buildEventSync({
      loanId: 'LN-1',
      kind: 'VISIT',
      outcome: 'paid',
      gps: NO_GPS,
      attemptedAtMs,
      tzOffsetMin: 330
    });
    expect(event.attempted_at_device).toBe('2026-11-06T06:30:00.000Z');
    expect(event.device_tz_offset_min).toBe(330);
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.loan_id).toBe('LN-1');
    expect(event.kind).toBe('VISIT');
    // No GPS fix and nothing requested: no coordinates, no status — never
    // fabricated (SPEC 7).
    expect(event.lat).toBeUndefined();
    expect(event.gps_status).toBeUndefined();
  });

  it('carries the LATEST stored skew for every new event', async () => {
    await setMeta(META_KEYS.SKEW_ESTIMATE_MS, -3_999_000);
    const event = await buildContactEvent({ loanId: 'LN-1', kind: 'CALL', outcome: 'dialled', gps: NO_GPS });
    expect(event.skew_estimate_ms).toBe(-3_999_000);
  });

  it('an explicit skew overrides the stored one (call paths pass the fresh reading)', async () => {
    await setMeta(META_KEYS.SKEW_ESTIMATE_MS, 111);
    const event = await buildContactEvent({ loanId: 'LN-1', kind: 'CALL', outcome: 'dialled', gps: NO_GPS, skewMs: 222 });
    expect(event.skew_estimate_ms).toBe(222);
  });

  it('a GPS fix lands on the event with accuracy; a denied sensor leaves only the status', async () => {
    const fixed = await buildContactEvent({
      loanId: 'LN-1',
      kind: 'VISIT',
      outcome: 'paid',
      gps: { fix: { lat: 22.7196, lng: 75.8577, accuracyM: 12, status: 'ok' }, rawStatus: 'ok' }
    });
    expect(fixed.lat).toBeCloseTo(22.7196);
    expect(fixed.lng).toBeCloseTo(75.8577);
    expect(fixed.accuracy_m).toBe(12);
    expect(fixed.gps_status).toBe('ok');

    const denied = await buildContactEvent({ loanId: 'LN-1', kind: 'VISIT', outcome: 'paid', gps: { fix: null, rawStatus: 'denied' } });
    expect(denied.lat).toBeUndefined();
    expect(denied.gps_status).toBe('denied');
  });
});

describe('client-side promise validation wraps the SHARED rules (SPEC 12 / A51)', () => {
  const today = '2026-11-06';

  it('accepts a valid promise (tomorrow, half the overdue)', () => {
    expect(validatePromiseClient('2026-11-07', 50_000, today, '1-30', 100_000, 500_000).ok).toBe(true);
  });

  it('rejects an amount below half the overdue with the shared reason', () => {
    const result = validatePromiseClient(today, 49_999, today, '1-30', 100_000, 500_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('amount_below_half_overdue');
  });

  it('rejects a Sunday date (the UI rolls forward with a visible note)', () => {
    // 2026-11-08 is a Sunday.
    const result = validatePromiseClient('2026-11-08', 100_000, today, '1-30', 100_000, 500_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('date_is_sunday');
  });
});
