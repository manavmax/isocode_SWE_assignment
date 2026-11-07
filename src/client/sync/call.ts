/**
 * The one-tap call flow (SPEC 7), extracted from LoanDetail so the Promises
 * screen reuses the exact same window gating and reveal logic (prompt 11
 * item 5). Orchestration only — the screens render their own sheets/errors
 * from the returned outcome: outside the window the tap still records a
 * BLOCKED attempt with the rule code (the attempt is the compliance record),
 * inside it the reveal runs and the CALL event is queued BEFORE the dialler
 * opens (SPEC 6: the outbox write precedes everything).
 */
import { isWithinContactWindow, ruleSetFor, CONTACT_WINDOW_RULE_CODE } from '../../shared/contactWindow.js';
import { buildContactEvent } from './buildEvent.js';
import { correctedNowMs } from './engine.js';
import { getSkew, queueEvent } from '../dexie/db.js';
import { getBorrowerPhone } from './reveal.js';
import { kick } from './scheduler.js';
import type { GpsState } from '../gps.js';

export type CallOutcome =
  | { kind: 'dialling' }
  | { kind: 'blocked'; ruleCode: string }
  | { kind: 'offline' }
  | { kind: 'revealError' }
  | { kind: 'noNumber' };

export async function attemptBorrowerCall(params: { loanId: string; gps: GpsState }): Promise<CallOutcome> {
  const skew = await getSkew();
  const corrected = correctedNowMs(Date.now(), skew);
  if (!isWithinContactWindow(corrected)) {
    // SPEC 7 layer (a): the button looks disabled but stays tappable —
    // tapping opens the Blocked sheet AND records a BLOCKED attempt with the
    // rule code (the rule-set version is stamped on sync, server-side).
    const ruleCode = ruleSetFor(ruleSetDateKey(corrected)).id;
    const payload = await buildContactEvent({
      loanId: params.loanId,
      kind: 'BLOCKED',
      outcome: 'not_reachable',
      gps: params.gps,
      note: CONTACT_WINDOW_RULE_CODE,
      skewMs: skew
    });
    await queueEvent(payload);
    void kick();
    return { kind: 'blocked', ruleCode };
  }
  const result = await getBorrowerPhone(params.loanId);
  if (result.offline) {
    return { kind: 'offline' };
  }
  if (result.error) {
    return { kind: 'revealError' };
  }
  if (!result.phone && !result.altPhone) {
    return { kind: 'noNumber' };
  }
  // Record the dial attempt BEFORE opening the dialler (SPEC 6: outbox
  // write precedes everything, and the attempt is the compliance record).
  const payload = await buildContactEvent({
    loanId: params.loanId,
    kind: 'CALL',
    outcome: 'dialled',
    gps: params.gps,
    skewMs: skew
  });
  await queueEvent(payload);
  void kick();
  const number = result.phone ?? result.altPhone;
  if (number) window.location.assign(`tel:${number}`);
  return { kind: 'dialling' };
}

function ruleSetDateKey(correctedMs: number): string {
  const shifted = new Date(correctedMs + 330 * 60_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}
