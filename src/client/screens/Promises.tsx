import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type BrokenPromiseCardDto, type LoanDetailDto, type PromiseCardDto } from '../api.js';
import { loadPromises, savePromises } from '../dexie/db.js';
import { getOutboxItems } from '../dexie/db.js';
import { formatIstTime } from '../../shared/datetime.js';
import { formatMoneyShort } from '../format.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { EmptyState, ErrorState, OfflineBanner, SkeletonList } from '../components/States.js';
import { startGpsWatch } from '../gps.js';
import type { GpsState } from '../gps.js';
import { attemptBorrowerCall } from '../sync/call.js';
import type { CallOutcome } from '../sync/call.js';
import { syncNow } from '../sync/scheduler.js';

// The outcome sheet is an on-tap surface — lazy (prompt 11 item 0 pattern).
const OutcomeSheet = lazy(() => import('../components/OutcomeSheet.js').then((m) => ({ default: m.OutcomeSheet })));
const BlockedSheet = lazy(() => import('../components/BlockedSheet.js').then((m) => ({ default: m.BlockedSheet })));

type Segment = 'due' | 'upcoming' | 'broken';
type Load = 'loading' | 'error' | 'ready';

/** A promise created offline: still in the outbox, shown in Upcoming with a
 *  "Not synced yet" tag until the flush confirms it (SPEC 6). */
interface PendingPromiseCard {
  promiseId: string;
  loanId: string;
  borrowerName: string;
  amountPaise: number;
  promisedDate: string;
  pending: true;
}

export function Promises({ lang, onOpenLoan }: { lang: Lang; onOpenLoan: (loanId: string) => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [sections, setSections] = useState<{ dueToday: PromiseCardDto[]; upcoming: PromiseCardDto[]; brokenNeedingFollowup: BrokenPromiseCardDto[] } | null>(null);
  const [pending, setPending] = useState<PendingPromiseCard[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [segment, setSegment] = useState<Segment>('due');
  const [gps, setGps] = useState<GpsState>({ fix: null, rawStatus: 'not_requested' });
  const [callLoadingId, setCallLoadingId] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [blockedRule, setBlockedRule] = useState<string | undefined>(undefined);
  const [sheetLoan, setSheetLoan] = useState<LoanDetailDto | null>(null);

  const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);

  const refresh = useCallback(async () => {
    setOffline(false);
    setFromCache(false);
    const result = await api.promises();
    if (result.ok) {
      const now = Date.now();
      setSections(result.data);
      setFetchedAt(now);
      await savePromises(result.data, now);
      setLoad('ready');
      return;
    }
    if (result.error.kind === 'network') {
      setOffline(true);
      const cached = await loadPromises();
      if (cached) {
        setFromCache(true);
        setSections(cached.sections);
        setFetchedAt(cached.fetchedAt);
        setLoad('ready');
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
      const cached = await loadPromises();
      if (cached) {
        setFromCache(true);
        setSections(cached.sections);
        setFetchedAt(cached.fetchedAt);
        setLoad('ready');
      }
      await refresh();
      const items = await getOutboxItems(100);
      setPending(
        items
          .filter((item) => item.payload.outcome === 'promise_to_pay' && item.state !== 'synced')
          .map((item) => ({
            promiseId: item.id,
            loanId: item.payload.loan_id,
            borrowerName: item.payload.loan_id, // the loan id stands in until sync returns the borrower
            amountPaise: item.payload.promised_amount ?? 0,
            promisedDate: item.payload.promised_date ?? '',
            pending: true
          }))
      );
    })();
  }, [refresh]);

  // GPS warm-up for the one-tap Call (SPEC 7: never blocks saving, the best
  // fix stays captured for the event just queued).
  useEffect(() => {
    const stop = startGpsWatch((state) => setGps(state));
    return () => stop();
  }, []);

  async function handleCall(loanId: string): Promise<void> {
    setRevealError(null);
    setCallLoadingId(loanId);
    const outcome: CallOutcome = await attemptBorrowerCall({ loanId, gps });
    setCallLoadingId(null);
    switch (outcome.kind) {
      case 'blocked':
        setBlockedRule(outcome.ruleCode);
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
        return;
    }
  }

  // Log outcome needs the loan's overdue/outstanding for the sheet's promise
  // validation: one fetch on tap, then the same sheet the detail screen uses.
  async function openOutcomeSheet(loanId: string): Promise<void> {
    setRevealError(null);
    const result = await api.loan(loanId);
    if (result.ok) {
      setSheetLoan(result.data.loan);
      return;
    }
    if (result.error.kind === 'unauthorized') {
      window.location.assign('/login');
      return;
    }
    setRevealError(tr('stateErrorBody'));
  }

  const due: (PromiseCardDto | PendingPromiseCard)[] = sections ? [...sections.dueToday] : [];
  const upcoming: (PromiseCardDto | PendingPromiseCard)[] = sections
    ? [...sections.upcoming, ...pending.filter((item) => !due.concat(sections.upcoming).some((card) => card.loanId === item.loanId))]
    : pending;

  return (
    <main className="screen">
      <header className="screen-header">
        <div className="today-header-row">
          <div>
            <h1 className="screen-title">{tr('promisesTitle')}</h1>
            <p className="screen-subtitle">
              {tr('promisesLastUpdated', { time: fetchedAt ? formatIstTime(fetchedAt) : '—' })}
              {fromCache && offline ? ` · ${tr('meOfflineCache')}` : ''}
            </p>
          </div>
          <button type="button" className="sync-pill" onClick={() => void syncNow()} title={tr('syncNow')}>
            <span className="sync-dot sync-dot-ok" aria-hidden="true" />
            {tr('syncNow')}
          </button>
        </div>
      </header>
      {offline ? <OfflineBanner text={tr('offlineBanner')} /> : null}
      {revealError ? (
        <div className="reveal-error">
          <p>{revealError}</p>
          <button type="button" className="btn btn-ghost" onClick={() => setRevealError(null)}>
            {tr('dismiss')}
          </button>
        </div>
      ) : null}

      <div className="segment-row" role="tablist" aria-label={tr('promisesTitle')}>
        <button type="button" role="tab" aria-selected={segment === 'due'} className={`segment ${segment === 'due' ? 'segment-active' : ''}`} onClick={() => setSegment('due')}>
          {tr('segmentDueToday')}
        </button>
        <button type="button" role="tab" aria-selected={segment === 'upcoming'} className={`segment ${segment === 'upcoming' ? 'segment-active' : ''}`} onClick={() => setSegment('upcoming')}>
          {tr('segmentUpcoming')}
        </button>
        <button type="button" role="tab" aria-selected={segment === 'broken'} className={`segment ${segment === 'broken' ? 'segment-active' : ''}`} onClick={() => setSegment('broken')}>
          {tr('segmentBroken')}
        </button>
      </div>

      {load === 'loading' ? <SkeletonList /> : null}
      {load === 'error' ? (
        <ErrorState title={tr('stateErrorTitle')} body={tr('stateErrorBody')} onRetry={() => void refresh()} retryLabel={tr('stateRetry')} />
      ) : null}

      {load === 'ready' && segment === 'due' ? (
        due.length === 0 ? (
          <EmptyState title={tr('promisesEmptyDue')} action={<button type="button" className="btn btn-secondary" onClick={() => void refresh()}>{tr('promisesEmptyAction')}</button>} />
        ) : (
          <div className="card-list">
            {due.map((card) => (
              <PromiseCardView
                key={card.promiseId}
                lang={lang}
                card={card}
                callLoading={callLoadingId === card.loanId}
                onCall={() => void handleCall(card.loanId)}
                onLogOutcome={() => void openOutcomeSheet(card.loanId)}
                onOpenLoan={onOpenLoan}
              />
            ))}
          </div>
        )
      ) : null}

      {load === 'ready' && segment === 'upcoming' ? (
        upcoming.length === 0 ? (
          <EmptyState title={tr('promisesEmptyUpcoming')} action={<button type="button" className="btn btn-secondary" onClick={() => void refresh()}>{tr('promisesEmptyAction')}</button>} />
        ) : (
          <div className="card-list">
            {upcoming.map((card) => (
              <PromiseCardView
                key={card.promiseId}
                lang={lang}
                card={card}
                callLoading={callLoadingId === card.loanId}
                onCall={() => void handleCall(card.loanId)}
                onLogOutcome={() => void openOutcomeSheet(card.loanId)}
                onOpenLoan={onOpenLoan}
              />
            ))}
          </div>
        )
      ) : null}

      {load === 'ready' && segment === 'broken' ? (
        (sections?.brokenNeedingFollowup.length ?? 0) === 0 ? (
          <EmptyState title={tr('promisesEmptyBroken')} action={<button type="button" className="btn btn-secondary" onClick={() => void refresh()}>{tr('promisesEmptyAction')}</button>} />
        ) : (
          <div className="card-list">
            {sections!.brokenNeedingFollowup.map((card) => (
              <PromiseCardView
                key={card.promiseId}
                lang={lang}
                card={card}
                callLoading={callLoadingId === card.loanId}
                onCall={() => void handleCall(card.loanId)}
                onLogOutcome={() => void openOutcomeSheet(card.loanId)}
                onOpenLoan={onOpenLoan}
              />
            ))}
          </div>
        )
      ) : null}

      {sheetLoan && (
        <Suspense fallback={null}>
          <OutcomeSheet
            lang={lang}
            defaultKind="CALL"
            overdueAmount={sheetLoan.overdueAmount}
            outstandingAmount={sheetLoan.outstanding}
            bucket={sheetLoan.bucket}
            onSave={() => setSheetLoan(null)}
            onClose={() => setSheetLoan(null)}
          />
        </Suspense>
      )}
      {blockedRule && (
        <Suspense fallback={null}>
          <BlockedSheet lang={lang} ruleCode={blockedRule} onClose={() => setBlockedRule(undefined)} />
        </Suspense>
      )}
    </main>
  );
}

type AnyCard = PromiseCardDto | PendingPromiseCard | BrokenPromiseCardDto;

function isPending(card: AnyCard): card is PendingPromiseCard {
  return 'pending' in card && card.pending;
}

function PromiseCardView({
  lang,
  card,
  callLoading,
  onCall,
  onLogOutcome,
  onOpenLoan
}: {
  lang: Lang;
  card: AnyCard;
  callLoading: boolean;
  onCall: () => void;
  onLogOutcome: () => void;
  onOpenLoan: (loanId: string) => void;
}) {
  const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
  const broken = 'daysPastDue' in card ? card : null;
  const statusChip = isPending(card)
    ? tr('promiseNotSynced')
    : card.status === 'broken'
      ? tr('promiseStatusBroken')
      : card.status === 'broken_part'
        ? tr('promiseStatusBrokenPart')
        : translate(lang, 'promiseStatusDue');
  return (
    <div className="card promise-card">
      <button type="button" className="promise-card-main" onClick={() => onOpenLoan(card.loanId)}>
        <span className="card-name">
          {card.borrowerName}
          {isPending(card) ? <span className="chip chip-warn">{tr('promiseNotSynced')}</span> : null}
        </span>
        <span className="card-amount money num">{formatMoneyShort(card.amountPaise)}</span>
        <span className="card-row">
          <span className="chip">{statusChip}</span>
          <span className="screen-subtitle num">{card.promisedDate}</span>
        </span>
        {broken ? (
          <span className="card-row">
            <span className="screen-subtitle">
              {tr('promiseBrokenFollowup')} · {tr('promiseStuck', { n: broken.daysPastDue })}
            </span>
          </span>
        ) : null}
        {broken?.needsManagerAttention ? (
          <span className="card-row">
            <span className="chip chip-warn">{tr('promiseManagerAttention')}</span>
          </span>
        ) : null}
      </button>
      <span className="promise-card-actions">
        <button type="button" className={`btn btn-secondary ${callLoading ? 'sticky-btn-loading' : ''}`} onClick={onCall} disabled={callLoading}>
          {callLoading ? tr('callLoading') : tr('callButton')}
        </button>
        <button type="button" className="btn btn-accent" onClick={onLogOutcome}>
          {tr('logOutcome')}
        </button>
      </span>
    </div>
  );
}
