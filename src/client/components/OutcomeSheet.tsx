import { useState } from 'react';
import { t as translate, type Lang, type DictKey } from '../i18n/dictionary.js';
import { validatePromiseCreation, type PromiseCreationReason } from '../../shared/promises.js';
import { useNow } from '../useNow.js';

export type OutcomeValue = 'paid' | 'promise_to_pay' | 'not_reachable' | 'dispute' | 'wrong_number';
export type KindValue = 'CALL' | 'VISIT';

interface Props {
  lang: Lang;
  defaultKind: KindValue;
  /** Paise (A11) — the amount chips prefill and the save path validates against. */
  overdueAmount: number;
  outstandingAmount: number;
  bucket: string;
  onSave: (data: {
    kind: KindValue;
    outcome: OutcomeValue;
    note: string | null;
    promisedDate?: string;
    promisedAmount?: number;
  }) => void;
  onClose: () => void;
}

const OUTCOME_CHIPS: { value: OutcomeValue; key: DictKey }[] = [
  { value: 'paid', key: 'outcomePaid' },
  { value: 'promise_to_pay', key: 'outcomePromise' },
  { value: 'not_reachable', key: 'outcomeNotReachable' },
  { value: 'dispute', key: 'outcomeDispute' },
  { value: 'wrong_number', key: 'outcomeWrongNumber' }
];

const DATE_CHIPS: { labelKey: DictKey; offset: number }[] = [
  { labelKey: 'promiseDateToday', offset: 0 },
  { labelKey: 'promiseDateTomorrow', offset: 1 },
  { labelKey: 'promiseDatePlus3', offset: 3 }
];

const REASON_KEYS: Record<PromiseCreationReason, DictKey> = {
  invalid_date: 'promiseErrInvalidDate',
  date_before_today: 'promiseErrBeforeToday',
  date_too_far_out: 'promiseErrTooFarOut',
  date_is_sunday: 'promiseErrSunday',
  amount_not_positive: 'promiseErrAmountPositive',
  amount_below_half_overdue: 'promiseErrAmountLow',
  amount_above_outstanding: 'promiseErrAmountHigh',
  reschedule_limit_reached: 'promiseErrReschedule'
};

/** IST calendar date (YYYY-MM-DD) of a UTC instant — the offset formula,
 * never the device timezone (SPEC 7). */
export function istDateKey(utcMs: number): string {
  const shifted = new Date(utcMs + 330 * 60_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** IST has no DST, so a fixed 86 400 s step on the UTC anchor is exact. */
export function addIstDays(dateKey: string, days: number): string {
  const shifted = new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function isSundayIst(dateKey: string): boolean {
  return new Date(Date.parse(`${dateKey}T12:00:00Z`) + 330 * 60_000).getUTCDay() === 0;
}

/** SPEC 12: a Sunday promised date rolls forward to the next working day —
 * with a visible note, never a silent mutation (A51). */
export function nextWorkingDay(dateKey: string): string {
  let k = dateKey;
  for (let i = 0; i < 10 && isSundayIst(k); i++) {
    k = addIstDays(k, 1);
  }
  return k;
}

export function OutcomeSheet({
  lang,
  defaultKind,
  overdueAmount,
  outstandingAmount,
  bucket,
  onSave,
  onClose
}: Props) {
  const tr = (key: DictKey) => translate(lang, key);
  // The clock arrives as state (useNow): date chips and validation stay pure
  // during render and refresh on the timer, never mid-render.
  const nowMs = useNow(30_000);
  const [kind, setKind] = useState<KindValue>(defaultKind);
  const [outcome, setOutcome] = useState<OutcomeValue | null>(null);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [showPromise, setShowPromise] = useState(false);
  const [promiseDate, setPromiseDate] = useState<string | null>(null);
  const [promiseError, setPromiseError] = useState<DictKey | null>(null);
  // Amount input is RUPEES for the officer; the payload carries paise (A11).
  const [amountRupees, setAmountRupees] = useState(String(Math.round(overdueAmount / 100)));

  function handleOutcomeTap(o: OutcomeValue) {
    setOutcome(o);
    setPromiseError(null);
    if (o === 'promise_to_pay') {
      setShowPromise(true);
      setPromiseDate(istDateKey(nowMs));
    } else {
      setShowPromise(false);
      setPromiseDate(null);
    }
  }

  function handlePromiseDateTap(offset: number) {
    let selected = addIstDays(istDateKey(nowMs), offset);
    if (isSundayIst(selected)) {
      selected = nextWorkingDay(selected);
      setPromiseError('promiseDateRolled');
    } else {
      setPromiseError(null);
    }
    setPromiseDate(selected);
  }

  function handleSave() {
    if (!outcome) return;
    if (outcome === 'promise_to_pay') {
      if (!promiseDate) return;
      // Client-side validation with the SHARED rules (SPEC 12 / A51): same
      // reasons the server grades with, judged on today's IST date.
      const amountPaise = Math.round(Number(amountRupees) * 100);
      const validation = validateLocal(promiseDate, amountPaise);
      if (!validation.ok) {
        setPromiseError(validation.reason);
        return;
      }
      onSave({
        kind,
        outcome,
        note: note || null,
        promisedDate: promiseDate,
        promisedAmount: amountPaise
      });
    } else {
      onSave({ kind, outcome, note: note || null });
    }
  }

  /** Runs the shared validatePromiseCreation over the sheet's inputs. */
  function validateLocal(dateKey: string, amountPaise: number): { ok: true } | { ok: false; reason: DictKey } {
    const result = validatePromiseCreation(
      { promised_date: dateKey, promised_amount: amountPaise },
      {
        todayIst: istDateKey(nowMs),
        bucket,
        overduePaise: overdueAmount,
        outstandingPaise: outstandingAmount,
        openPromiseId: null,
        rescheduleCount: 0
      }
    );
    if (result.ok) return { ok: true };
    const first = result.reasons[0]!;
    return { ok: false, reason: REASON_KEYS[first] };
  }

  const canSave = outcome !== null && (outcome !== 'promise_to_pay' || promiseDate !== null);

  return (
    <dialog
      open
      className="outcome-sheet"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sheet-content">
        <div className="sheet-handle" aria-hidden="true" />
        <p className="sheet-title">{tr('outcomeSheetTitle')}</p>

        <div className="kind-toggle chip-row" role="group" aria-label={tr('kindToggle')}>
          <button
            type="button"
            className={`chip ${kind === 'CALL' ? 'chip-selected' : ''}`}
            onClick={() => setKind('CALL')}
          >
            {tr('kindCall')}
          </button>
          <button
            type="button"
            className={`chip ${kind === 'VISIT' ? 'chip-selected' : ''}`}
            onClick={() => setKind('VISIT')}
          >
            {tr('kindVisit')}
          </button>
        </div>

        <div className="chip-row" role="group" aria-label={tr('outcomeLabel')}>
          {OUTCOME_CHIPS.map(({ value, key }) => (
            <button
              key={value}
              type="button"
              className={`chip outcome-chip ${outcome === value ? 'chip-selected' : ''}`}
              onClick={() => handleOutcomeTap(value)}
            >
              {tr(key)}
            </button>
          ))}
        </div>

        {showPromise && promiseDate !== null && (
          <div className="promise-fields">
            <p className="promise-amount-label">{tr('promiseAmountLabel')}</p>
            <input
              type="number"
              className="promise-amount-input"
              value={amountRupees}
              onChange={(e) => setAmountRupees(e.target.value)}
              inputMode="numeric"
              lang="en"
              min={1}
              aria-label={tr('promiseAmountLabel')}
            />
            <div className="chip-row">
              {DATE_CHIPS.map(({ labelKey, offset }) => {
                const k = addIstDays(istDateKey(nowMs), offset);
                const sunday = isSundayIst(k);
                return (
                  <button
                    key={labelKey}
                    type="button"
                    className={`chip ${promiseDate === k ? 'chip-selected' : ''} ${sunday ? 'chip-sunday' : ''}`}
                    onClick={() => handlePromiseDateTap(offset)}
                  >
                    {tr(labelKey)}
                    {sunday ? '*' : ''}
                  </button>
                );
              })}
            </div>
            {promiseError && <p className="field-note" role="alert">{tr(promiseError)}</p>}
          </div>
        )}

        {showNote ? (
          <div className="field">
            <textarea
              className="note-input"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tr('notePlaceholder')}
              maxLength={1000}
            />
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost add-note-btn"
            onClick={() => setShowNote(true)}
          >
            {tr('addDetails')}
          </button>
        )}

        <div className="sheet-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {tr('cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave}
            onClick={handleSave}
          >
            {tr('save')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
