import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LoanDetailDto } from '../api.js';
import { formatRupeePaise } from '../../shared/money.js';
import { isWithinContactWindow } from '../../shared/contactWindow.js';
import { ruleSetFor } from '../../shared/contactWindow.js';
import { CONTACT_WINDOW_RULE_CODE } from '../../shared/contactWindow.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { BucketChip, ErrorState, SkeletonList } from '../components/States.js';
import { bucketLabel } from './Today.js';
import { OutcomeSheet, type OutcomeValue, type KindValue } from '../components/OutcomeSheet.js';
import { BlockedSheet } from '../components/BlockedSheet.js';
import { UndoToast } from '../components/UndoToast.js';
import { startGpsWatch } from '../gps.js';
import type { GpsState } from '../gps.js';
import { buildContactEvent } from '../sync/buildEvent.js';
import { correctedNowMs } from '../sync/engine.js';
import { getSkew, setMeta, getMeta, META_KEYS, queueEvent, undoItem } from '../dexie/db.js';
import { getBorrowerPhone } from '../sync/reveal.js';
import { kick } from '../sync/scheduler.js';

type Load = 'loading' | 'ready' | 'error' | 'notFound';

export function LoanDetail({ lang, loanId, onBack }: { lang: Lang; loanId: string; onBack: () => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [loan, setLoan] = useState<LoanDetailDto | null>(null);
  const [gps, setGps] = useState<GpsState>({ fix: null, rawStatus: 'not_requested' });
  const [showOutcome, setShowOutcome] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [blockedRule, setBlockedRule] = useState<string | undefined>(undefined);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [callLoading, setCallLoading] = useState(false);
  const [lastKind, setLastKind] = useState<KindValue>('CALL');
  // null until the skew-corrected clock has answered (SPEC 7: the window is
  // judged on the corrected instant, never on the raw device clock).
  const [inWindow, setInWindow] = useState<boolean | null>(null);
  const stopGpsRef = useRef<(() => void) | null>(null);

  const tr = (key: Parameters<typeof translate>[1]) => translate(lang, key);

  const fetchLoan = useCallback(async () => {
    const result = await api.loan(loanId);
    if (result.ok) {
      setLoan(result.data.loan);
      setLoad('ready');
    } else if (result.error.kind === 'notFound') {
      setLoad('notFound');
    } else if (result.error.kind === 'unauthorized') {
      window.location.assign('/login');
    } else {
      setLoad('error');
    }
  }, [loanId]);

  function startGps(): void {
    stopGpsRef.current?.();
    stopGpsRef.current = startGpsWatch((state) => setGps(state));
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const storedKind = await getMeta(META_KEYS.LAST_OUTCOME_KIND);
      if (mounted && storedKind !== null) {
        setLastKind(storedKind === 1 ? 'VISIT' : 'CALL');
      }
      await refreshWindow();
      await fetchLoan();
      // First paint first, then the GPS warm-up (SPEC 7: never blocks saving).
      startGps();
    })();
    const iv = setInterval(() => void refreshWindow(), 60_000);
    return () => {
      mounted = false;
      clearInterval(iv);
      stopGpsRef.current?.();
      stopGpsRef.current = null;
    };
    async function refreshWindow(): Promise<void> {
      const skew = await getSkew();
      if (mounted) setInWindow(isWithinContactWindow(correctedNowMs(Date.now(), skew)));
    }
  }, [fetchLoan]);

  function retry(): void {
    setLoad('loading');
    void fetchLoan();
  }

  function mapsHref(l: LoanDetailDto): string {
    const query = [l.address, l.locality, l.pincode].filter(Boolean).join(', ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  async function handleCallTap() {
    if (!loan) return;
    const skew = await getSkew();
    const corrected = correctedNowMs(Date.now(), skew);
    if (!isWithinContactWindow(corrected)) {
      // SPEC 7 layer (a): the button looks disabled but stays tappable —
      // tapping opens the Blocked sheet AND records a BLOCKED attempt with
      // the rule code (the rule-set version is stamped on sync, server-side).
      const ruleCode = ruleSetFor(ruleSetDateKey(corrected)).id;
      setBlockedRule(ruleCode);
      setShowBlocked(true);
      const payload = await buildContactEvent({
        loanId,
        kind: 'BLOCKED',
        outcome: 'not_reachable',
        gps,
        note: CONTACT_WINDOW_RULE_CODE,
        skewMs: skew
      });
      await queueEvent(payload);
      void kick();
      return;
    }
    setRevealError(null);
    setCallLoading(true);
    const result = await getBorrowerPhone(loanId);
    setCallLoading(false);
    if (result.offline) {
      setRevealError(tr('revealOffline'));
      return;
    }
    if (result.error) {
      setRevealError(tr('revealOutsideWindow'));
      return;
    }
    if (!result.phone && !result.altPhone) {
      setRevealError(tr('revealError'));
      return;
    }
    // Record the dial attempt BEFORE opening the dialler (SPEC 6: outbox
    // write precedes everything, and the attempt is the compliance record).
    const payload = await buildContactEvent({
      loanId,
      kind: 'CALL',
      outcome: 'dialled',
      gps,
      skewMs: skew
    });
    await queueEvent(payload);
    void kick();
    const number = result.phone ?? result.altPhone;
    if (number) window.location.assign(`tel:${number}`);
  }

  async function handleOutcomeSave(data: {
    kind: KindValue;
    outcome: OutcomeValue;
    note: string | null;
    promisedDate?: string;
    promisedAmount?: number;
  }) {
    const skew = await getSkew();
    const payload = await buildContactEvent({
      loanId,
      kind: data.kind,
      outcome: data.outcome,
      promisedDate: data.promisedDate,
      promisedAmount: data.promisedAmount,
      note: data.note,
      gps,
      skewMs: skew
    });
    // Undo hold (prompt 10b): the item sits unsendable for 5 s so Undo can
    // delete it locally — after that it syncs like any other event.
    const id = await queueEvent(payload, 5_000);
    setUndoId(id);
    setShowOutcome(false);
    void kick();
    await setMeta(META_KEYS.LAST_OUTCOME_KIND, data.kind === 'CALL' ? 0 : 1);
    // The watch is cleared on save (SPEC 7 GPS); the next outcome warms a
    // fresh one while the best fix stays captured for the event just queued.
    startGps();
  }

  function handleUndo(id: string) {
    void undoItem(id, Date.now);
  }

  return (
    <main className="screen">
      <div className="topbar">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ‹ {tr('back')}
        </button>
        <span className="topbar-title">{tr('detailTitle')}</span>
      </div>

      {load === 'loading' ? <SkeletonList rows={2} /> : null}
      {load === 'error' ? (
        <ErrorState title={tr('stateErrorTitle')} body={tr('stateErrorBody')} onRetry={retry} retryLabel={tr('stateRetry')} />
      ) : null}
      {load === 'notFound' ? (
        <ErrorState title={tr('notFoundTitle')} body={tr('notFoundBody')} onRetry={onBack} retryLabel={tr('back')} />
      ) : null}

      {load === 'ready' && loan ? (
        <>
          <div className="detail-hero">
            <h1 className="card-name">{loan.borrowerName}</h1>
            <p className="card-amount money num">{formatRupeePaise(loan.overdueAmount)}</p>
            <div className="card-row">
              <BucketChip bucket={loan.bucket} label={bucketLabel(lang, loan.bucket)} />
              <span className="screen-subtitle num">
                {tr('factDpd')}: {loan.dpd}
              </span>
            </div>
          </div>

          <div className="facts">
            {factRow(tr('factLoanId'), loan.loanId)}
            {factRow(tr('factOutstanding'), formatRupeePaise(loan.outstanding), true)}
            {factRow(tr('factOverdue'), formatRupeePaise(loan.overdueAmount), true)}
            {loan.emiAmount !== null ? factRow(tr('factEmi'), formatRupeePaise(loan.emiAmount), true) : null}
            {factRow(tr('factStatus'), statusLabel(lang, loan.status))}
            {loan.product ? factRow(tr('factProduct'), loan.product) : null}
            {loan.address ? factRow(tr('factAddress'), loan.address) : null}
            {loan.locality ? factRow(tr('factLocality'), loan.locality) : null}
            {factRow(tr('factPincode'), loan.pincode ?? '—')}
            {factRow(tr('factPhone'), loan.mobileMasked ?? '—', true)}
            {factRow(tr('factAltPhone'), loan.altMobileMasked ?? '—', true)}
          </div>

          {revealError && (
            <div className="reveal-error">
              <p>{revealError}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setRevealError(null)}>
                {tr('dismiss')}
              </button>
            </div>
          )}

          <div className="sticky-bar">
            <button
              type="button"
              className={`sticky-btn ${callLoading ? 'sticky-btn-loading' : ''} ${inWindow === false ? 'sticky-btn-muted' : ''}`}
              onClick={() => void handleCallTap()}
              disabled={callLoading}
            >
              {callLoading ? tr('callLoading') : tr('callButton')}
            </button>
            <a
              className="sticky-btn"
              href={mapsHref(loan)}
              target="_blank"
              rel="noreferrer"
            >
              {tr('mapButtonLabel')}
            </a>
            <button
              type="button"
              className="sticky-btn sticky-btn-accent"
              onClick={() => setShowOutcome(true)}
            >
              {tr('logOutcome')}
            </button>
          </div>
        </>
      ) : null}

      {showOutcome && loan && (
        <OutcomeSheet
          lang={lang}
          defaultKind={lastKind}
          overdueAmount={loan.overdueAmount}
          outstandingAmount={loan.outstanding}
          bucket={loan.bucket}
          onSave={(data) => void handleOutcomeSave(data)}
          onClose={() => setShowOutcome(false)}
        />
      )}

      {showBlocked && (
        <BlockedSheet
          lang={lang}
          ruleCode={blockedRule}
          onClose={() => setShowBlocked(false)}
        />
      )}

      {undoId && (
        <UndoToast
          lang={lang}
          itemId={undoId}
          onUndo={handleUndo}
          onDone={() => setUndoId(null)}
        />
      )}
    </main>
  );
}

function ruleSetDateKey(correctedMs: number): string {
  const shifted = new Date(correctedMs + 330 * 60_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function factRow(label: string, value: string, money = false) {
  return (
    <div className="fact-row" key={label}>
      <span className="fact-label">{label}</span>
      <span className={`fact-value ${money ? 'money num' : ''}`}>{value}</span>
    </div>
  );
}

export function statusLabel(lang: Lang, status: string): string {
  if (status === 'cleared') return translate(lang, 'statusCleared');
  if (status === 'queue') return translate(lang, 'statusQueue');
  return translate(lang, 'statusOverdue');
}
