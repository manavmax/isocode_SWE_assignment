import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, type LoanDetailDto } from '../api.js';
import { formatMoneyExact } from '../format.js';
import { isWithinContactWindow } from '../../shared/contactWindow.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { describeEvidence, describeReason } from '../../shared/scoring/phrases.js';
import { visibleReasons } from '../reasons.js';
import { ErrorState, SkeletonList } from '../components/States.js';
import { bucketIndex, bucketLabel } from './Today.js';
import type { OutcomeValue, KindValue } from '../components/OutcomeSheet.js';
import { startGpsWatch } from '../gps.js';
import type { GpsState } from '../gps.js';
import { attemptBorrowerCall } from '../sync/call.js';
import { buildContactEvent } from '../sync/buildEvent.js';
import { correctedNowMs } from '../sync/engine.js';
import { getSkew, setMeta, getMeta, META_KEYS, queueEvent, undoItem, saveLoan, loadLoan, loadAssignmentCard } from '../dexie/db.js';
import { loanOfflineFallback } from '../dexie/loanFallback.js';
import { kick } from '../sync/scheduler.js';

// The sheets only render on a tap, so they load on first open instead of
// riding the detail route (SPEC 3 budget): the outcome sheet carries the
// promise validation + GPS-linked flow, the blocked sheet the rule-set text.
const OutcomeSheet = lazy(() =>
  import('../components/OutcomeSheet.js').then((m) => ({ default: m.OutcomeSheet }))
);
const BlockedSheet = lazy(() => import('../components/BlockedSheet.js').then((m) => ({ default: m.BlockedSheet })));
const UndoToast = lazy(() => import('../components/UndoToast.js').then((m) => ({ default: m.UndoToast })));

type Load = 'loading' | 'ready' | 'error' | 'notFound';

/**
 * layout contract ("detail"): top-bar -> hero -> facts -> why -> history -> actions
 * (floating pill bar). data-section attributes mark each section.
 */
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

  const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);

  const fetchLoan = useCallback(async () => {
    const result = await api.loan(loanId);
    if (result.ok) {
      setLoan(result.data.loan);
      setLoad('ready');
      await saveLoan(result.data.loan);
      return;
    }
    if (result.error.kind === 'notFound') {
      setLoad('notFound');
      return;
    }
    if (result.error.kind === 'unauthorized') {
      window.location.assign('/login');
      return;
    }
    // Offline or server error: hydrate from the Dexie caches (prompt 19.1).
    // The floating action bar renders in every non-null case so the officer
    // can still queue an outcome offline.
    const cachedDetail = await loadLoan(loanId);
    const cachedCard = await loadAssignmentCard(loanId);
    const fallback = loanOfflineFallback(loanId, cachedDetail?.detail, cachedCard);
    if (fallback) {
      setLoan(fallback.detail);
      setLoad('ready');
      return;
    }
    setLoad('error');
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
    setCallLoading(true);
    const outcome = await attemptBorrowerCall({ loanId, gps });
    setCallLoading(false);
    switch (outcome.kind) {
      case 'blocked':
        setBlockedRule(outcome.ruleCode);
        setShowBlocked(true);
        return;
      case 'offline':
        setRevealError(tr('revealOffline'));
        return;
      case 'revealError':
        setRevealError(tr('revealOutsideWindow'));
        return;
      case 'noNumber':
        setRevealError(tr('revealError'));
        return;
      default:
        return; // dialling: the dialler has the number now
    }
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
    <>
      <main className="screen detail-screen">
      <div className="topbar" data-section="top-bar">
        <button type="button" className="topbar-icon icon-button" aria-label={tr('back')} onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <span className="topbar-title">{tr('detailTitle')}</span>
        <button type="button" className="topbar-icon icon-button" aria-label="More options">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="icon-fill">
            <circle cx="12" cy="5" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>
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
          <div className={`detail-hero mesh-b${bucketIndex(loan.bucket)}`} data-hero data-section="hero">
            <p className="bucket-name num">{bucketLabel(lang, loan.bucket)}</p>
            <h1 className="card-name">{loan.borrowerName}</h1>
            {loan.businessName ? <p className="business">{loan.businessName}</p> : null}
            <p className="amount-hero money num">{formatMoneyExact(loan.overdueAmount)}</p>
            <p className="amount-sub num">
              {loan.dpd === 1 ? tr('daysOverdueOne') : tr('daysOverdue', { n: loan.dpd })}
            </p>
          </div>

          <div className="detail-card" data-section="facts">
            <div className="facts">
              {factRow(tr('factOutstanding'), formatMoneyExact(loan.outstanding), true)}
              {loan.emiAmount !== null ? factRow(tr('factEmi'), formatMoneyExact(loan.emiAmount), true) : null}
              {factRow(tr('factLastContact'), loan.lastContactDays === null ? '—' : (loan.lastContactDays === 0 ? tr('todayLabelShort') : tr('daysAgo', { n: loan.lastContactDays })))}
              {factRow(tr('factPromise'), loan.openPromiseDue ?? '—')}
              {factRow(tr('factDpd'), String(loan.dpd))}
              {factRow(tr('factStatus'), statusLabel(lang, loan.status))}
              {loan.product ? factRow(tr('factProduct'), loan.product) : null}
              {factRow(tr('factPincode'), loan.pincode ?? '—')}
              {loan.address ? factRow(tr('factAddress'), loan.address) : null}
              {factRow(tr('factPhone'), loan.mobileMasked ?? '—', true)}
              {factRow(tr('factAltPhone'), loan.altMobileMasked ?? '—', true)}
            </div>
          </div>

          {loan.score !== null ? (
            <div className="score-panel detail-card" data-section="why">
              <p className="score-inline">
                {tr('scoreAdvisory')}: <span className="num">{loan.score}</span> ·{' '}
                {translate(lang, loan.band === 'high' ? 'scoreBandHigh' : loan.band === 'medium' ? 'scoreBandMedium' : 'scoreBandLow')}
                {loan.limitedData ? ` · ${tr('scoreLimitedData')}` : ''}
              </p>
              {(() => {
                const reasons = visibleReasons(loan.topReasons);
                return reasons.length > 0 ? (
                  <>
                    <p className="score-reasons-title">{tr('scoreReasonsTitle')}</p>
                    <ol className="score-reasons">
                      {reasons.map((reason) => (
                        <li key={reason.feature}>
                          {describeReason(lang, reason)}
                          <span className="reason-evidence">{describeEvidence(lang, reason)}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null;
              })()}
              <p className="score-how">{tr('scoreAdvisoryLine')}</p>
            </div>
          ) : null}

          {revealError && (
            <div className="reveal-error">
              <p>{revealError}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setRevealError(null)}>
                {tr('dismiss')}
              </button>
            </div>
          )}

          <div className="detail-card" data-section="history">
            <h2 className="score-reasons-title">{tr('historyTitle')}</h2>
            <ul className="history-list">
              <li>
                <span>{tr('factLastContact')}</span>
                <span className="num">
                  {loan.lastContactDays === null ? '—' : loan.lastContactDays === 0 ? tr('todayLabelShort') : tr('daysAgo', { n: loan.lastContactDays })}
                </span>
              </li>
              <li>
                <span>{tr('factPromise')}</span>
                <span className="num">{loan.openPromiseDue ?? '—'}</span>
              </li>
              <li>
                <span>{tr('factStatus')}</span>
                <span>{statusLabel(lang, loan.status)}</span>
              </li>
            </ul>
          </div>
        </>
      ) : null}
    </main>
    {load === 'ready' && loan ? (
    <div className="sticky-bar" data-float data-section="actions">
            <div className="sticky-side">
              <button
                type="button"
                aria-label={callLoading ? tr('callLoading') : tr('callButton')}
                className={`sticky-btn ${callLoading ? 'sticky-btn-loading' : ''} ${inWindow === false ? 'sticky-btn-muted' : ''}`}
                onClick={() => void handleCallTap()}
                disabled={callLoading}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
                </svg>
              </button>
              <a
                className="sticky-btn"
                aria-label={tr('mapButtonLabel')}
                href={mapsHref(loan)}
                target="_blank"
                rel="noreferrer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                  <path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z" />
                  <circle cx="12" cy="11" r="2" />
                </svg>
              </a>
            </div>
            <button type="button" className="sticky-btn sticky-btn-accent" onClick={() => setShowOutcome(true)}>
              {tr('logOutcome')}
            </button>
    </div>
      ) : null}

      {showOutcome && loan && (
        <Suspense fallback={null}>
          <OutcomeSheet
            lang={lang}
            defaultKind={lastKind}
            overdueAmount={loan.overdueAmount}
            outstandingAmount={loan.outstanding}
            bucket={loan.bucket}
            onSave={(data) => void handleOutcomeSave(data)}
            onClose={() => setShowOutcome(false)}
          />
        </Suspense>
      )}

      {showBlocked && (
        <Suspense fallback={null}>
          <BlockedSheet
            lang={lang}
            ruleCode={blockedRule}
            onClose={() => setShowBlocked(false)}
          />
        </Suspense>
      )}

      {undoId && (
        <Suspense fallback={null}>
          <UndoToast
            lang={lang}
            itemId={undoId}
            onUndo={handleUndo}
            onDone={() => setUndoId(null)}
          />
        </Suspense>
      )}
    </>
  );
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
