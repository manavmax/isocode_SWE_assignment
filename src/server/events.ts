/**
 * POST /api/events/batch core (SPEC 6 + hard part #2, prompt 10a). The route
 * in app.ts stays thin: session, officer role, envelope; everything else
 * happens here, one item at a time, so a single bad event can never block
 * the queue (SPEC 6 "Return HTTP 200 with [{id, status, reason}]").
 *
 * Per item: validate against the shared schema; confirm the loan is either
 * currently assigned to this officer or shows up in their assignment history
 * (accept + flag `assignment_changed` otherwise, per SPEC 6); re-derive the
 * window from device time AND skew-corrected time (never from sync time),
 * grading `time_confidence` high/low/suspect; mark COMPLIANT or
 * VIOLATION_DETECTED — a violation is recorded, never thrown away (SPEC 7).
 * Writes go in one transaction per item: the contact_event append (idempotent,
 * ON CONFLICT (id) DO NOTHING) plus, for a valid promise outcome, the
 * promise row (SPEC 12) and the superseding update of any previous promise.
 * The promise window is judged on the ATTEMPT's IST date (the skew-corrected
 * best estimate, A51) — a promise made offline on Monday and synced on
 * Thursday is valid if it was valid on Monday.
 */
import { and, eq, or } from 'drizzle-orm';
import { getDb, withTx } from './db.js';
import { assignmentLog, auditLog, contactEvents, loans, promises } from './db/schema.js';
import { contactEventInputSchema } from '../shared/sync/eventSchema.js';
import { istDateKey } from '../shared/datetime.js';
import { isWithinContactWindow, ruleSetFor } from '../shared/contactWindow.js';
import { DEFAULT_PROMISE_GRACE_DAYS, validatePromiseCreation } from '../shared/promises.js';
import type { TimeConfidence } from '../shared/types.js';
import type { Actor } from './dal.js';

/** Slack before a device stamp in the future is called a backwards clock
 * instead of a fast one (network latency + headroom). */
export const CLOCK_AHEAD_ALLOWANCE_MS = 2 * 60_000;
/** A supplied skew smaller than this means the stamp was taken right after
 * the last flush, so the corrected time is 'high' confidence (SPEC 7: fresh
 * sync and skew < 5 min). A52: approximation — freshness is inferred. */
export const SKEW_FRESH_MAX_MS = 5 * 60_000;

export interface BatchItemResult {
  /** Echoed even for rejected items so the outbox can match the verdict. */
  id: string | null;
  status: 'created' | 'duplicate' | 'rejected';
  reason?: string;
  assignmentChanged?: boolean;
  complianceStatus?: 'COMPLIANT' | 'VIOLATION_DETECTED';
  /**
   * Soft failures attached to a `created` item (SPEC 6 + prompt 10b): the
   * contact event — the compliance record — is always stored; a business rule
   * that only fails the side-effect (e.g. a promise outcome) skips that side
   * effect and reports it here, never rejects the whole event.
   */
  warnings?: { code: string; reason: string }[];
}

export interface EventBatchOutcome {
  items: BatchItemResult[];
  serverNow: string;
}

export interface AttemptTiming {
  attemptedAtIstMs: number;
  deviceWithinWindow: boolean;
  correctedWithinWindow: boolean;
  /** The stored column: true only when BOTH derivations agree. */
  withinWindow: boolean;
  timeConfidence: TimeConfidence;
  ruleSetId: string;
  attemptDateIstKey: string;
  complianceStatus: 'COMPLIANT' | 'VIOLATION_DETECTED';
}

/** Server-side window + confidence derivation (SPEC 7 layer b). Pure: no db,
 * no clock — the route's `nowMs` is injected, so the tests can freeze time.
 * attempted_at_ist lands on the skew-corrected instant (best estimate of the
 * truth); with unknown skew it equals the device stamp. */
export function deriveAttemptTiming(params: {
  attemptedAtDeviceMs: number;
  skewEstimateMs: number | null;
  nowMs: number;
}): AttemptTiming {
  const skew = params.skewEstimateMs ?? 0;
  const attemptedAtIstMs = params.attemptedAtDeviceMs - skew;
  const deviceWithinWindow = isWithinContactWindow(params.attemptedAtDeviceMs);
  const correctedWithinWindow = isWithinContactWindow(attemptedAtIstMs);

  let timeConfidence: TimeConfidence;
  if (params.attemptedAtDeviceMs > params.nowMs + CLOCK_AHEAD_ALLOWANCE_MS) {
    // The stamp claims time the server has not reached yet: a backwards clock
    // jump on the device. Flag it, never silently reject (SPEC 7).
    timeConfidence = 'suspect';
  } else if (params.skewEstimateMs != null && Math.abs(params.skewEstimateMs) < SKEW_FRESH_MAX_MS) {
    timeConfidence = 'high';
  } else {
    // Unknown skew or a stale/heavy correction — low.
    timeConfidence = 'low';
  }

  const dateKey = istDateKey(attemptedAtIstMs);
  return {
    attemptedAtIstMs,
    deviceWithinWindow,
    correctedWithinWindow,
    withinWindow: deviceWithinWindow && correctedWithinWindow,
    timeConfidence,
    ruleSetId: ruleSetFor(dateKey).id,
    attemptDateIstKey: dateKey,
    complianceStatus: deviceWithinWindow && correctedWithinWindow ? 'COMPLIANT' : 'VIOLATION_DETECTED'
  };
}

/** Canonical retry signature: identical payloads are sync retries, anything
 * else sharing an id is a mismatch (keep the first, log it). */
export function eventPayloadSignature(input: {
  loan_id: string;
  kind: string;
  outcome: string;
  attempted_at_device: string;
  device_tz_offset_min: number;
}): string {
  return JSON.stringify([
    input.loan_id,
    input.kind,
    input.outcome,
    Date.parse(input.attempted_at_device),
    input.device_tz_offset_min
  ]);
}

export function storedEventPayloadSignature(row: {
  loanId: string;
  kind: string;
  outcome: string | null;
  attemptedAtDevice: Date;
  deviceTzOffsetMinutes: number;
}): string {
  return eventPayloadSignature({
    loan_id: row.loanId,
    kind: row.kind,
    outcome: row.outcome ?? '',
    attempted_at_device: row.attemptedAtDevice.toISOString(),
    device_tz_offset_min: row.deviceTzOffsetMinutes
  });
}

interface PromisePlan {
  supersedesPromiseId: string | null;
  promisedDateIst: string;
  promisedAmountPaise: number;
}

/** Grade every item. Kept as its own exported function so the route can
 * focus on auth + envelope; the loop order defines the per-item query count
 * the fake driver queues in tests (loan → event → promises → write). */
export async function processEventBatch(
  actor: Actor & { officerId: string },
  rawEvents: unknown[],
  nowMs: number
): Promise<EventBatchOutcome> {
  const items: BatchItemResult[] = [];
  for (const rawEvent of rawEvents) {
    items.push(await gradeEventItem(actor, rawEvent, nowMs));
  }
  return { items, serverNow: new Date(nowMs).toISOString() };
}

function echoId(rawEvent: unknown): string | null {
  const candidate = (rawEvent as { id?: unknown } | null)?.id;
  return typeof candidate === 'string' ? candidate : null;
}

async function gradeEventItem(
  actorOfficer: Actor & { officerId: string },
  rawEvent: unknown,
  nowMs: number
): Promise<BatchItemResult> {
  const parsed = contactEventInputSchema.safeParse(rawEvent);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first ? `${String(first.path[0] ?? 'payload')}: ${first.message}` : 'invalid payload';
    return { id: echoId(rawEvent), status: 'rejected', reason: `invalid_event (${detail})` };
  }
  const event = parsed.data;
  const deviceMs = Date.parse(event.attempted_at_device);
  const timing = deriveAttemptTiming({
    attemptedAtDeviceMs: deviceMs,
    skewEstimateMs: event.skew_estimate_ms ?? null,
    nowMs
  });

  const db = getDb();
  const loanRows = await db
    .select({
      loanId: loans.loanId,
      assignedOfficerId: loans.assignedOfficerId,
      bucket: loans.bucket,
      outstanding: loans.outstanding,
      overdueAmount: loans.overdueAmount
    })
    .from(loans)
    .where(eq(loans.loanId, event.loan_id))
    .limit(1);
  const loan = loanRows[0];
  if (!loan) {
    return { id: event.id, status: 'rejected', reason: 'unknown_loan' };
  }

  // SPEC 6: a loan reassigned while the officer was offline is accepted and
  // flagged. The officer must appear in the loan's assignment history at
  // least once (as the previous or new hand) — a stranger's loan is refused.
  let assignmentChanged = false;
  if (loan.assignedOfficerId !== actorOfficer.officerId) {
    const historyRows = await db
      .select({ id: assignmentLog.id })
      .from(assignmentLog)
      .where(
        and(
          eq(assignmentLog.loanId, event.loan_id),
          or(
            eq(assignmentLog.toOfficer, actorOfficer.officerId),
            eq(assignmentLog.fromOfficer, actorOfficer.officerId)
          )
        )
      )
      .limit(1);
    if (historyRows.length === 0) {
      return { id: event.id, status: 'rejected', reason: 'loan_not_assigned_to_officer' };
    }
    assignmentChanged = true;
  }

  // Idempotency first: a retry with the same payload stops here (created on
  // the last flush, or crashed before marking synced). Never create a second
  // promise for a duplicate flush either.
  const existingRows = await db
    .select({
      loanId: contactEvents.loanId,
      kind: contactEvents.kind,
      outcome: contactEvents.outcome,
      attemptedAtDevice: contactEvents.attemptedAtDevice,
      deviceTzOffsetMinutes: contactEvents.deviceTzOffsetMinutes
    })
    .from(contactEvents)
    .where(eq(contactEvents.id, event.id))
    .limit(1);
  const existing = existingRows[0];
  if (existing) {
    const samePayload = storedEventPayloadSignature(existing) === eventPayloadSignature(event);
    if (!samePayload) {
      // Same id, different payload: the first write wins, the mismatch is
      // logged, and the flush still reports duplicate (SPEC 6).
      await db.insert(auditLog).values({
        actor: `sync:${actorOfficer.username}`,
        action: 'event_duplicate_mismatch',
        subject: event.id,
        detail: { loanId: event.loan_id, kind: event.kind }
      });
      return {
        id: event.id,
        status: 'duplicate',
        reason: 'payload_mismatch_kept_first',
        assignmentChanged,
        complianceStatus: timing.complianceStatus
      };
    }
    return {
      id: event.id,
      status: 'duplicate',
      assignmentChanged,
      complianceStatus: timing.complianceStatus
    };
  }

  // SPEC 12: a promise outcome carries the promise payload. Because the
  // schema already demands promised_date/promised_amount for it, a failure
  // reaching here is a business rule (window, amounts, cap), not a wire one.
  let promisePlan: PromisePlan | null = null;
  let promiseWarning: { code: string; reason: string } | null = null;
  if (event.outcome === 'promise_to_pay') {
    const openRows = await db
      .select({ id: promises.id })
      .from(promises)
      .where(and(eq(promises.loanId, event.loan_id), eq(promises.status, 'open')))
      .limit(1);
    const supersededRows = await db
      .select({ id: promises.id })
      .from(promises)
      .where(and(eq(promises.loanId, event.loan_id), eq(promises.status, 'superseded')))
      .limit(100);
    const validation = validatePromiseCreation(
      {
        promised_date: event.promised_date ?? '',
        promised_amount: event.promised_amount ?? -1
      },
      {
        todayIst: timing.attemptDateIstKey,
        bucket: loan.bucket,
        overduePaise: loan.overdueAmount,
        outstandingPaise: loan.outstanding,
        openPromiseId: openRows[0]?.id ?? null,
        rescheduleCount: supersededRows.length
      }
    );
    // A promise whose business rules fail NEVER rejects the event (prompt
    // 10b): the call/visit happened and the contact_event row is the
    // compliance record, so it is always stored. Only the promise row is
    // skipped and the item answers `created` with a promise_not_created
    // warning carrying the real reason (A57). A schema-invalid item or a
    // stranger-loan item is still rejected whole — there is nothing to store.
    if (!validation.ok) {
      promiseWarning = { code: 'promise_not_created', reason: validation.reasons[0] };
    } else {
      promisePlan = {
        supersedesPromiseId: validation.supersedesPromiseId,
        promisedDateIst: validation.promisedDateIst,
        promisedAmountPaise: validation.promisedAmountPaise
      };
    }
  }

  try {
    const written = await withTx(async (tx) => {
      const insertedRows = await tx
        .insert(contactEvents)
        .values({
          id: event.id,
          loanId: event.loan_id,
          officerId: actorOfficer.officerId,
          kind: event.kind,
          outcome: event.outcome,
          attemptedAtDevice: new Date(deviceMs),
          deviceTzOffsetMinutes: event.device_tz_offset_min,
          skewEstimateMs: event.skew_estimate_ms ?? null,
          // Server clock only — never a client value (SPEC 6).
          syncedAt: new Date(nowMs),
          attemptedAtIst: new Date(timing.attemptedAtIstMs),
          withinWindow: timing.withinWindow,
          timeConfidence: timing.timeConfidence,
          ruleSet: timing.ruleSetId,
          lat: event.lat ?? null,
          lng: event.lng ?? null,
          accuracyM: event.accuracy_m ?? null,
          gpsStatus: event.gps_status ?? null,
          note: event.note ?? null,
          correctsEventId: event.corrects_event_id ?? null,
          complianceStatus: timing.complianceStatus
        })
        .onConflictDoNothing()
        .returning({ id: contactEvents.id });

      if (insertedRows.length === 0) {
        // Lost a race with another flush of the same id: still idempotent.
        return {
          id: event.id,
          status: 'duplicate' as const,
          reason: 'concurrent_duplicate',
          assignmentChanged,
          complianceStatus: timing.complianceStatus
        };
      }

      if (promisePlan !== null) {
        const promiseRows = await tx
          .insert(promises)
          .values({
            loanId: event.loan_id,
            officerId: actorOfficer.officerId,
            sourceEventId: event.id,
            promisedAmount: promisePlan.promisedAmountPaise,
            promisedDate: promisePlan.promisedDateIst,
            graceDays: DEFAULT_PROMISE_GRACE_DAYS,
            status: 'open'
          })
          .returning({ id: promises.id });
        if (promisePlan.supersedesPromiseId) {
          await tx
            .update(promises)
            .set({
              status: 'superseded',
              resolvedAt: new Date(nowMs),
              supersededBy: promiseRows[0]!.id
            })
            .where(eq(promises.id, promisePlan.supersedesPromiseId));
        }
      }

      return {
        id: event.id,
        status: 'created' as const,
        assignmentChanged,
        complianceStatus: timing.complianceStatus,
        ...(promiseWarning ? { warnings: [promiseWarning] } : {})
      };
    });
    return written;
  } catch (error) {
    console.warn('[sync] item write failed', event.id, error instanceof Error ? error.message : error);
    return { id: event.id, status: 'rejected', reason: 'write_failed' };
  }
}
