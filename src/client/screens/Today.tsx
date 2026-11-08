import { useCallback, useEffect, useState } from 'react';
import { api, type AssignmentCard } from '../api.js';
import { loadAssignments, saveAssignments, savePromises } from '../dexie/db.js';
import { formatIstTime } from '../../shared/datetime.js';
import { formatLakhCrore } from '../../shared/money.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { describeReason } from '../../shared/scoring/phrases.js';
import { EmptyState, ErrorState, OfflineBanner, SkeletonList } from '../components/States.js';
import { useOutboxCounts } from '../sync/useOutboxCounts.js';
import { syncNow } from '../sync/scheduler.js';

type Load = 'loading' | 'empty' | 'error' | 'ready';

export function Today({ lang, onOpenLoan }: { lang: Lang; onOpenLoan: (loanId: string) => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [loans, setLoans] = useState<AssignmentCard[]>([]);
  const [scoringMode, setScoringMode] = useState<'scorecard' | 'fallback'>('fallback');
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const counts = useOutboxCounts();
  const [promisesDue, setPromisesDue] = useState(0);

  const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);

  const refresh = useCallback(async () => {
    setOffline(false);
    setFromCache(false);
    const result = await api.assignments();
    if (result.ok) {
      const now = Date.now();
      setLoans(result.data.assignments);
      setScoringMode(result.data.scoringMode);
      setFetchedAt(now);
      await saveAssignments(result.data.assignments, now);
      setLoad(result.data.assignments.length === 0 ? 'empty' : 'ready');
      return;
    }
    if (result.error.kind === 'network') {
      setOffline(true);
      const cached = await loadAssignments();
      if (cached) {
        setFromCache(true);
        setLoans(cached.loans);
        setFetchedAt(cached.fetchedAt);
        setLoad(cached.loans.length === 0 ? 'empty' : 'ready');
        return;
      }
      setLoad('error');
      return;
    }
    if (result.error.kind === 'unauthorized') {
      window.location.assign('/login');
      return;
    }
    setLoad('error');
  }, []);

  useEffect(() => {
    void (async () => {
      const cached = await loadAssignments();
      if (cached) {
        setFromCache(true);
        setLoans(cached.loans);
        setFetchedAt(cached.fetchedAt);
        setLoad(cached.loans.length === 0 ? 'empty' : 'ready');
      }
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // The header's "n promises due" line: best-effort read, never blocks.
  useEffect(() => {
    void (async () => {
      const result = await api.promises();
      if (result.ok) {
        setPromisesDue(result.data.dueToday.length);
        await savePromises(result.data, Date.now());
      }
    })();
  }, []);

  // The server owns the worklist order (SPEC 8: promise-due pinned, rupees
  // at risk, low lane last; fallback = broken/DPD/overdue). The client
  // never re-sorts; it renders the low lane behind a quiet divider.
  const sorted = loans;
  const visitCount = sorted.length;
  const firstLowIndex = sorted.findIndex((loan) => loan.lowLane);

  function todayLabel(): string {
    // "Sunday, 8 Nov" on the corrected IST clock (device clock is fine for a
    // label; the contact window uses the skew-corrected one).
    const now = new Date();
    const shifted = new Date(now.getTime() + 330 * 60_000);
    return shifted.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function syncPillLabel(): string {
    if (counts.failed > 0) return `${counts.failed} ${tr('pillFailed')}`;
    if (counts.pending > 0) return `${counts.pending} ${tr('pillPending')}`;
    return tr('pillSynced');
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <div className="today-header-row">
          <div>
            <p className="today-date num">{todayLabel()}</p>
            <h1 className="today-headline">
              {visitCount === 1 ? tr('todayVisitsTodayOne') : tr('todayVisitsToday', { n: visitCount })}
            </h1>
            {promisesDue > 0 ? <p className="today-sub num">{tr('promisesDueToday', { n: promisesDue })}</p> : null}
            <p className="screen-subtitle">
              {tr('todayLastUpdated', { time: fetchedAt ? formatIstTime(fetchedAt) : '—' })}
            </p>
          </div>
          <button
            type="button"
            className="sync-pill"
            onClick={() => void syncNow()}
            title={tr('syncNow')}
            aria-live="polite"
          >
            <span className={`sync-dot ${counts.failed > 0 ? 'sync-dot-fail' : counts.pending > 0 ? 'sync-dot-pending' : 'sync-dot-ok'}`} aria-hidden="true" />
            {syncPillLabel()}
          </button>
        </div>
      </header>
      {offline || !online ? <OfflineBanner text={tr('offlineBanner')} /> : null}
      {scoringMode === 'fallback' && load === 'ready' ? <OfflineBanner text={tr('scoreStandardOrder')} /> : null}
      {load === 'loading' ? <SkeletonList /> : null}
      {load === 'empty' ? (
        <EmptyState title={tr('todayEmptyTitle')} action={<button type="button" className="btn btn-secondary" onClick={() => void refresh()}>{tr('todayEmptyAction')}</button>} />
      ) : null}
      {load === 'error' ? (
        <ErrorState title={tr('stateErrorTitle')} body={tr('stateErrorBody')} onRetry={() => void refresh()} retryLabel={tr('stateRetry')} />
      ) : null}
      {load === 'ready' && fromCache && offline ? <p className="cached-note">{tr('meOfflineCache')}</p> : null}
      {load === 'ready' ? (
        <div className="card-list">
          {sorted.map((loan, index) => (
            <>
              {index === firstLowIndex ? <p className="lane-divider">Low priority</p> : null}
              <button
              type="button"
              key={loan.loanId}
              className={`card bucket-${bucketIndex(loan.bucket)}${loan.lowLane ? ' lane-low' : ''}`}
              onClick={() => onOpenLoan(loan.loanId)}
            >
              <span className="card-name">
                {loan.borrowerName}
                {loan.pinned ? <span className="chip chip-warn">{tr('pinnedByManager')}</span> : null}
                {loan.limitedData ? <span className="chip">{tr('scoreLimitedData')}</span> : null}
              </span>
              {loan.businessName ? <span className="card-sub">{loan.businessName}</span> : null}
              <span className="card-row">
                <span className="card-sub num">
                  {loan.dpd === 1 ? tr('daysOverdueOne') : tr('daysOverdue', { n: loan.dpd })}
                  {loan.score !== null ? (
                    <span className="score-inline">
                      {' · '}
                      {translate(lang, loan.band === 'high' ? 'scoreBandHigh' : loan.band === 'medium' ? 'scoreBandMedium' : 'scoreBandLow')}{' '}
                      <span className="num">{loan.score}</span>
                    </span>
                  ) : null}
                </span>
                <span className="card-amount money num">{formatLakhCrore(loan.overdueAmount / 100)}</span>
              </span>
              {loan.duePromise ? <span className="score-reason">{tr('promiseDueLabel')}</span> : null}
              {loan.topReasons && loan.topReasons.length > 0 ? (
                <span className="score-reason">{describeReason(lang, loan.topReasons[0]!)}</span>
              ) : null}
            </button>
            </>
          ))}
        </div>
      ) : null}
    </main>
  );
}

export function bucketLabel(lang: Lang, bucket: string): string {
  switch (bucket) {
    case 'not-overdue':
      return translate(lang, 'bucketNotOverdue');
    case '1-30':
      return translate(lang, 'bucket1to30');
    case '31-60':
      return translate(lang, 'bucket31to60');
    case '61-90':
      return translate(lang, 'bucket61to90');
    case '90+':
      return translate(lang, 'bucket90plus');
    default:
      return bucket;
  }
}

/** The 3px rail index for a row's DPD bucket (1-4, clamped). */
export function bucketIndex(bucket: string): number {
  switch (bucket) {
    case '1-30':
      return 1;
    case '31-60':
      return 2;
    case '61-90':
      return 3;
    default:
      return 4;
  }
}
