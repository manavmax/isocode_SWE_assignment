import { useCallback, useEffect, useState } from 'react';
import { api, type LoanDetailDto } from '../api.js';
import { formatRupeePaise } from '../../shared/money.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { BucketChip, ErrorState, SkeletonList } from '../components/States.js';
import { bucketLabel } from './Today.js';

type Load = 'loading' | 'ready' | 'error' | 'notFound';

export function LoanDetail({ lang, loanId, onBack }: { lang: Lang; loanId: string; onBack: () => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [loan, setLoan] = useState<LoanDetailDto | null>(null);

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

  useEffect(() => {
    void (async () => {
      await fetchLoan();
    })();
  }, [fetchLoan]);

  function retry(): void {
    setLoad('loading');
    void fetchLoan();
  }

  function mapsHref(l: LoanDetailDto): string {
    const query = [l.address, l.locality, l.pincode].filter(Boolean).join(', ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
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
          <p style={{ marginTop: 'var(--sp-4)' }}>
            <a className="btn btn-secondary" href={mapsHref(loan)} target="_blank" rel="noreferrer">
              {tr('mapButton')}
            </a>
          </p>
        </>
      ) : null}
    </main>
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
