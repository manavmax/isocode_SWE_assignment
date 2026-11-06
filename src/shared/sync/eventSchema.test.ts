import { describe, expect, it } from 'vitest';
import {
  contactEventBatchSchema,
  contactEventInputSchema,
  DEVICE_TZ_OFFSET_MAX_MIN,
  EVENT_NOTE_MAX_CHARS,
  GPS_STATUS_REQUIRED_FOR,
  MAX_EVENT_BATCH,
  SERVER_EXCLUDED_FIELDS,
  SKEW_ESTIMATE_MAX_MS,
  type ContactEventInput
} from './eventSchema.js';

/** A minimal event the schema must accept as-is. The `over` parameter is
 * deliberately loose: deliberately-broken payloads (kind 'LETTER', outcome
 * 'ghosted') must not be blocked by the test's own typing. */
function base(over: Record<string, unknown> = {}): ContactEventInput {
  return {
    id: '0b9a2f42-8f6f-4bc8-9d3e-1f2a3c4d5e6f',
    loan_id: 'LN-10001',
    kind: 'CALL',
    outcome: 'paid',
    attempted_at_device: '2026-11-06T05:30:00.000Z', // 11:00 IST, browser Z-stamp
    device_tz_offset_min: 330,
    ...over
  } as unknown as ContactEventInput;
}

/** Issue summary for assertions on zod diagnostics. */
const issueText = (parsed: { success: false; error: { issues: { path?: unknown; message: string }[] } }) =>
  parsed.error.issues.map((issue) => `${String(issue.path ?? '')}: ${issue.message}`);

describe('contactEventInputSchema — happy paths', () => {
  it('accepts the minimal event and defaults nothing away', () => {
    const parsed = contactEventInputSchema.safeParse(base());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome).toBe('paid');
      expect(parsed.data.skew_estimate_ms).toBeUndefined();
      expect(parsed.data.note).toBeUndefined();
    }
  });

  it('accepts a fully-populated event with GPS, skew, note and a correction target', () => {
    const parsed = contactEventInputSchema.safeParse({
      ...base(),
      skew_estimate_ms: -42_000,
      note: 'Met the borrower at the shop',
      lat: 22.7196,
      lng: 75.8577,
      accuracy_m: 18,
      gps_status: 'ok',
      corrects_event_id: '0b9a2f42-8f6f-4bc8-9d3e-1f2a3c4d5e70'
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the A50 outcome additions dispute and dialled', () => {
    for (const outcome of ['dispute', 'dialled'] as const) {
      const parsed = contactEventInputSchema.safeParse(base({ outcome }));
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts a device stamp carrying its own UTC offset (offline Android formats)', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ attempted_at_device: '2026-11-06T11:00:00+05:30' })
    );
    expect(parsed.success).toBe(true);
  });
});

describe('contactEventInputSchema — identity and required fields', () => {
  it('rejects a non-UUID id (the client generates crypto.randomUUID(); the server must not mint ids)', () => {
    const parsed = contactEventInputSchema.safeParse(base({ id: 'local-7' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty loan_id and a kind outside CALL/VISIT/MESSAGE/BLOCKED', () => {
    expect(contactEventInputSchema.safeParse(base({ loan_id: '' })).success).toBe(false);
    expect(contactEventInputSchema.safeParse(base({ kind: 'LETTER' })).success).toBe(false);
  });

  it('rejects outcomes outside the shared enum (reused, not re-declared)', () => {
    expect(contactEventInputSchema.safeParse(base({ outcome: 'ghosted' })).success).toBe(false);
  });

  it('rejects a device offset past the ±14h bounds', () => {
    expect(contactEventInputSchema.safeParse(base({ device_tz_offset_min: 841 })).success).toBe(false);
    expect(contactEventInputSchema.safeParse(base({ device_tz_offset_min: -841 })).success).toBe(false);
    expect(
      contactEventInputSchema.safeParse(base({ device_tz_offset_min: DEVICE_TZ_OFFSET_MAX_MIN })).success
    ).toBe(true);
    expect(
      contactEventInputSchema.safeParse(base({ device_tz_offset_min: -DEVICE_TZ_OFFSET_MAX_MIN })).success
    ).toBe(true);
  });

  it('rejects a skew estimate beyond ±24h and a non-integer skew', () => {
    expect(
      contactEventInputSchema.safeParse(base({ skew_estimate_ms: SKEW_ESTIMATE_MAX_MS + 1 })).success
    ).toBe(false);
    expect(contactEventInputSchema.safeParse(base({ skew_estimate_ms: 1.5 })).success).toBe(false);
  });

  it('rejects a note longer than the cap', () => {
    expect(
      contactEventInputSchema.safeParse(base({ note: 'x'.repeat(EVENT_NOTE_MAX_CHARS + 1) })).success
    ).toBe(false);
    expect(
      contactEventInputSchema.safeParse(base({ note: 'x'.repeat(EVENT_NOTE_MAX_CHARS) })).success
    ).toBe(true);
  });

  it('rejects an attempted_at_device that is not an ISO instant', () => {
    expect(contactEventInputSchema.safeParse(base({ attempted_at_device: 'yesterday evening' })).success).toBe(
      false
    );
  });
});

describe('contactEventInputSchema — never a client synced_at (SPEC 6/20)', () => {
  it('rejects a payload carrying synced_at, naming the offending key', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ synced_at: '2026-11-06T10:00:00Z' } as unknown as Partial<ContactEventInput>)
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const text = issueText(parsed).join('; ');
      expect(text).toContain('synced_at');
    }
  });

  it('rejects any other unknown key too (strict envelope, future-proof the wire)', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ client_bonus_field: true } as unknown as Partial<ContactEventInput>)
    );
    expect(parsed.success).toBe(false);
  });

  it('SERVER_EXCLUDED_FIELDS documents the keys the server owns and never reads', () => {
    expect(SERVER_EXCLUDED_FIELDS).toContain('synced_at');
    expect(SERVER_EXCLUDED_FIELDS).not.toContain('loan_id');
  });
});

describe('contactEventInputSchema — GPS block (SPEC 7: never fabricate coordinates)', () => {
  it('accepts a complete ok fix with accuracy and allows the fix to be absent entirely', () => {
    expect(
      contactEventInputSchema.safeParse(
        base({ lat: 22.7196, lng: 75.8577, accuracy_m: 18, gps_status: 'ok' })
      ).success
    ).toBe(true);
    expect(contactEventInputSchema.safeParse(base()).success).toBe(true);
  });

  it('rejects half a position — lat without lng is a fabricated coordinate', () => {
    expect(contactEventInputSchema.safeParse(base({ lat: 22.7196 })).success).toBe(false);
    expect(contactEventInputSchema.safeParse(base({ lng: 75.8577 })).success).toBe(false);
  });

  it('rejects a claimed-ok fix without coordinates, and coordinates stamped denied', () => {
    expect(contactEventInputSchema.safeParse(base({ gps_status: 'ok' })).success).toBe(false);
    expect(
      contactEventInputSchema.safeParse(base({ lat: 22.7196, lng: 75.8577, accuracy_m: 4, gps_status: 'denied' }))
        .success
    ).toBe(false);
  });

  it('accepts failure statuses without coordinates', () => {
    for (const status of ['denied', 'unavailable', 'timeout', 'not_requested'] as const) {
      expect(contactEventInputSchema.safeParse(base({ gps_status: status })).success).toBe(true);
    }
  });

  it('rejects coordinates outside the globe', () => {
    expect(
      contactEventInputSchema.safeParse(base({ lat: 91, lng: 75.8577, gps_status: 'ok' })).success
    ).toBe(false);
    expect(
      contactEventInputSchema.safeParse(base({ lat: 22.7, lng: -181, gps_status: 'ok' })).success
    ).toBe(false);
  });
});

describe('contactEventInputSchema — the promise outcome carries its needs, and only then', () => {
  it('requires promised_date and promised_amount for promise_to_pay', () => {
    const missing = contactEventInputSchema.safeParse(base({ outcome: 'promise_to_pay' }));
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const text = issueText(missing).join('; ');
      expect(text).toContain('promised_date');
      expect(text).toContain('promised_amount');
    }
  });

  it('accepts the complete promise payload', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ outcome: 'promise_to_pay', promised_date: '2026-11-09', promised_amount: 500000 })
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a bad promised_date (no 2026-02-30)', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ outcome: 'promise_to_pay', promised_date: '2026-02-30', promised_amount: 1000 })
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects promise fields on non-promise outcomes', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ outcome: 'paid', promised_date: '2026-11-09', promised_amount: 500000 })
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-positive promised_amount', () => {
    expect(
      contactEventInputSchema.safeParse(
        base({ outcome: 'promise_to_pay', promised_date: '2026-11-09', promised_amount: 0 })
      ).success
    ).toBe(false);
  });
});

describe('contactEventInputSchema — corrections (append-only model, SPEC 5)', () => {
  it('accepts a correction targeting another event', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ corrects_event_id: '0b9a2f42-8f6f-4bc8-9d3e-1f2a3c4d5e99' })
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects an event correcting itself', () => {
    const parsed = contactEventInputSchema.safeParse(
      base({ corrects_event_id: base().id })
    );
    expect(parsed.success).toBe(false);
  });
});

describe('contactEventBatchSchema — the sync envelope', () => {
  it('accepts a batch of 20 and rejects 21 (PROMPT 10a: max 20 items)', () => {
    expect(contactEventBatchSchema.safeParse({ events: Array.from({ length: MAX_EVENT_BATCH }, () => base()) }).success).toBe(true);
    expect(
      contactEventBatchSchema.safeParse({ events: Array.from({ length: MAX_EVENT_BATCH + 1 }, () => base()) }).success
    ).toBe(false);
  });

  it('rejects an empty batch and a non-object envelope', () => {
    expect(contactEventBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(contactEventBatchSchema.safeParse([base()]).success).toBe(false);
  });

  it('the envelope carries unknown items through (per-item validation stays the endpoint’s job)', () => {
    const parsed = contactEventBatchSchema.safeParse({ events: [42] });
    expect(parsed.success).toBe(true);
  });
});

describe('GPS status coupling helper', () => {
  it('lists the two statuses that promise a real fix', () => {
    expect(GPS_STATUS_REQUIRED_FOR).toEqual(['ok', 'low_accuracy']);
  });
});
