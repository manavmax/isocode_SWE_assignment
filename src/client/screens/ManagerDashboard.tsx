import { useCallback, useEffect, useState } from 'react';
import { api, type ManagerDashboardDto } from '../api.js';
import { formatLakhCrore } from '../../shared/money.js';
import { ErrorState, SkeletonList } from '../components/States.js';

/**
 * Manager dashboard (SPEC 13, prompt 13 items 2/6). English only (A67).
 * Every number and chart carries its footnote: numerator, denominator,
 * count or balance, cohort type, synthetic data. Charts are hand-rolled
 * SVG — no chart library.
 */

type Load = 'loading' | 'ready' | 'error';


function pct(value: number | null): string {
  return value === null ? '—' : `${(100 * value).toFixed(1)}%`;
}

/** Dot-matrix trend: columns of 4px dots (one per 5-point step), filled
 *  dots for the value, the dashed 16% target labelled in the axis row.
 *  Hand-rolled, no chart library. */
function DotMatrixChart({ trend }: { trend: { t0: string; t1: string; rollRateCount: number | null }[] }) {
  const completed = trend.filter((point) => point.rollRateCount !== null);
  if (completed.length < 2) {
    return <p className="screen-subtitle">Not enough completed windows for a trend yet.</p>;
  }
  const shown = completed.slice(-24);
  const DOTS = 12;
  const STEP = 0.05; // one dot per 5 percentage points
  return (
    <div>
      <div className="dotmatrix" role="img" aria-label="Roll rate trend, one column per completed window">
        {shown.map((point) => {
          const rate = point.rollRateCount as number;
          const filled = Math.min(DOTS, Math.round(rate / STEP));
          return (
            <div key={point.t0} className="dotmatrix-col" title={`${point.t0}: ${(rate * 100).toFixed(1)}%`}>
              {Array.from({ length: DOTS }, (_, i) => (
                <span key={i} className={i < filled ? 'filled' : ''} />
              ))}
            </div>
          );
        })}
      </div>
      <p className="dotmatrix-axis num">
        <span>0%</span>
        <span>– – – 16% target</span>
        <span>60%</span>
      </p>
    </div>
  );
}

/** Simple bars: rolled share per opening bucket in the migration table. */
function MigrationBars({ rows }: { rows: { openingBucket: string; cohortN: number; rolledShare: number; curedShare: number; stayedShare: number }[] }) {
  return (
    <div className="chart">
      {rows.map((row) => (
        <div key={row.openingBucket} className="migration-row">
          <span className="migration-label num">{row.openingBucket} (n={row.cohortN})</span>
          <span className="migration-bar">
            <span className="migration-seg migration-rolled" style={{ width: `${row.rolledShare * 100}%` }} />
            <span className="migration-seg migration-stayed" style={{ width: `${row.stayedShare * 100}%` }} />
            <span className="migration-seg migration-cured" style={{ width: `${row.curedShare * 100}%` }} />
          </span>
          <span className="num">{(row.rolledShare * 100).toFixed(1)}% rolled</span>
        </div>
      ))}
    </div>
  );
}

/**
 * layout contract ("manager"): top-bar -> segmented -> kpis -> chart -> tables ->
 * nav (floating pill). data-section attributes mark each section; the
 * tables section bundles the officer/migration/broken/exceptions/stuck
 * white cards.
 */
export function ManagerDashboard({ onOpenActivity, onOpenImport, onOpenActivityRoute }: { onOpenActivity: (officerId: string) => void; onOpenImport: () => void; onOpenActivityRoute: () => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [data, setData] = useState<ManagerDashboardDto | null>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const [pinDone, setPinDone] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await api.managerDashboard();
    if (result.ok) {
      setData(result.data);
      setLoad('ready');
    } else {
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  async function pin(loanId: string, officerName: string | null): Promise<void> {
    if (!data || !officerName) {
      return;
    }
    const officer = data.officerTable.find((row) => row.officerName === officerName);
    if (!officer) {
      return; // unassigned loans have no officer to pin to
    }
    setPinBusy(loanId);
    const result = await api.pinLoan(loanId, officer.officerId);
    setPinBusy(null);
    setPinDone(result.ok ? loanId : null);
  }

  const footnote = 'Numerator: loans rolling to 31+ DPD. Denominator: the 1-30 DPD cohort at the window start. Count and balance versions shown. Cohort: opening snapshot, attributed to the opening branch/officer. Synthetic data.';

  return (
    <main className="screen manager-screen" data-auto-centered="true">
      <div className="topbar" data-section="top-bar">
        <span className="topbar-spacer" aria-hidden="true" />
        <span className="topbar-title">{data?.branchName ?? 'Dashboard'}</span>
        <button type="button" className="topbar-icon" aria-label="Refresh" onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
          </svg>
        </button>
      </div>
      <h1 className="screen-title">Branch dashboard</h1>
      <nav className="manager-seg" aria-label="Manager sections" data-section="segmented">
        <button type="button" aria-current="page" onClick={() => undefined}>Overview</button>
        <button type="button" onClick={onOpenImport}>Import</button>
        <button type="button" onClick={onOpenActivityRoute}>Activity</button>
      </nav>
      {load === 'loading' ? <SkeletonList rows={4} /> : null}
      {load === 'error' ? (
        <ErrorState title="Couldn't reach server" body="Check your connection and try again." onRetry={() => void refresh()} retryLabel="Retry" />
      ) : null}
      {load === 'ready' && data ? (
        <>
          {data.tiles === null ? (
            <p className="screen-subtitle">No completed 30-day window yet — the roll rate shows "pending", never zero.</p>
          ) : (
            <>
            <div className="tile-grid" data-section="kpis">
              <div className="tile gradient-b1" data-hero>
                <span className="tile-label">Roll B1→B2, count (target 16%)</span>
                <span className="tile-value num">{pct(data.tiles.rollRateCount)}</span>
                <span className="tile-label">{data.tiles.loansToSave} loans to save</span>
              </div>
              <div className="tile gradient-b2" data-hero>
                <span className="tile-label">Roll B1→B2, balance</span>
                <span className="tile-value num">{pct(data.tiles.rollRateAmount)}</span>
                <span className="tile-label">of {formatLakhCrore(data.tiles.cohortAmt / 100)} cohort</span>
              </div>
              <div className="tile gradient-b4" data-hero>
                <span className="tile-label">Promises kept</span>
                <span className="tile-value num">
                  {data.keptRate === null ? '—' : pct(data.keptRate)} <span className="tile-unit">({data.keptMade} settled)</span>
                </span>
                <span className="tile-label">{data.openBrokenPromises} open broken</span>
              </div>
            </div>
            <div className="tile-grid">
              <div className="tile">
                <span className="tile-value num">{data.queueCount}</span>
                <span className="tile-label">Queued loans (branch)</span>
              </div>
              <div className="tile">
                <span className="tile-value num">{data.blockedAttempts30d}</span>
                <span className="tile-label">Blocked attempts, 30 days</span>
              </div>
            </div>
            </>
          )}
          <p className="footnote">
            {data.tiles
              ? `Counts: ${data.tiles.rolledN} rolled of ${data.tiles.cohortN} cohort loans. Balances: ${formatLakhCrore(data.tiles.rolledAmt / 100)} rolled of ${formatLakhCrore(data.tiles.cohortAmt / 100)}. Wilson 95%: ${data.tiles.wilson ? `${pct(data.tiles.wilson.low)}–${pct(data.tiles.wilson.high)}` : 'n/a'}. ${footnote}`
              : footnote}
          </p>

          <section className="panel detail-card" data-section="chart">
            <h2 className="panel-title">Roll-rate trend ({data.trendWindowsAvailable} completed windows)</h2>
            <DotMatrixChart trend={data.trend} />
            <p className="footnote">{footnote}</p>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Migration table (latest completed window)</h2>
            <MigrationBars rows={data.migrationTable} />
            <p className="footnote">Rows: opening DPD bucket at the window start. Shares of the opening cohort: cured (left the book or DPD 0), stayed (same bucket), rolled (next bucket up). Sum to 1 per row. Synthetic data.</p>
          </section>

          <section className="panel detail-card" data-section="tables">
            <h2 className="panel-title">Officers (roll rate by opening attribution)</h2>
            <table className="manager-table">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>n</th>
                  <th>Rolled</th>
                  <th>Roll %</th>
                  <th>Wilson 95%</th>
                  <th>Kept rate</th>
                  <th>Workload</th>
                  <th>Activity</th>
                </tr>
              </thead>
              <tbody>
                {data.officerTable.map((row) => (
                  <tr key={row.officerId} className={row.greyedOut ? 'greyed' : ''}>
                    <td>{row.officerName}</td>
                    <td className="num">{row.cohortN}</td>
                    <td className="num">{row.rolledN}</td>
                    <td className="num">{pct(row.cohortN > 0 ? row.rollRate : null)}</td>
                    <td className="num">{row.wilson ? `${pct(row.wilson.low)}–${pct(row.wilson.high)}` : '—'}</td>
                    <td className="num">{row.keptRate === null ? '—' : pct(row.keptRate)}</td>
                    <td className="num">{row.workload}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" onClick={() => onOpenActivity(row.officerId)}>
                        Last 50 events
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="footnote">Greyed rows have n &lt; 30 (SPEC 13). Kept rate = kept / (kept + broken + broken_part) over the officer's own promises. Workload = currently assigned overdue loans. Synthetic data.</p>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Broken promises (oldest break first)</h2>
            {data.brokenPromises.length === 0 ? (
              <p className="screen-subtitle">None — nothing to escalate.</p>
            ) : (
              <table className="manager-table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Borrower</th>
                    <th>Amount</th>
                    <th>Break age</th>
                    <th>Officer</th>
                    <th>Pin to top</th>
                  </tr>
                </thead>
                <tbody>
                  {data.brokenPromises.map((row) => (
                    <tr key={row.promiseId}>
                      <td className="num">{row.loanId}</td>
                      <td>{row.borrowerName}</td>
                      <td className="num">{formatLakhCrore(row.amountPaise / 100)}</td>
                      <td className="num">{row.ageDays} d</td>
                      <td>{row.officerName ?? '—'}</td>
                      <td>
                        <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                          {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="footnote">Amount = the promised amount (paise to lakh/crore). Age = days since the break was recorded. Pin sends the loan to the top of its officer's Today list. Synthetic data.</p>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Exceptions: 25–30 DPD, no promise, no contact in 5 days</h2>
            {data.exceptions.length === 0 ? (
              <p className="screen-subtitle">No exceptions today.</p>
            ) : (
              <table className="manager-table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Borrower</th>
                    <th>DPD</th>
                    <th>Overdue</th>
                    <th>Officer</th>
                    <th>Pin to top</th>
                  </tr>
                </thead>
                <tbody>
                  {data.exceptions.map((row) => (
                    <tr key={row.loanId}>
                      <td className="num">{row.loanId}</td>
                      <td>{row.borrowerName}</td>
                      <td className="num">{row.dpd}</td>
                      <td className="num">{formatLakhCrore(row.overdueAmount / 100)}</td>
                      <td>{row.officerName ?? '—'}</td>
                      <td>
                        <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                          {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="footnote">Numerator: branch loans 25–30 DPD with no open promise and no CALL/VISIT/MESSAGE in the last 5 IST days. Denominator: the branch overdue book. Synthetic data.</p>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Stuck promises (nightly list)</h2>
            {data.stuckPromises.length === 0 ? (
              <p className="screen-subtitle">No stuck promises — nothing 2+ days past due without action.</p>
            ) : (
              <table className="manager-table">
                <thead>
                  <tr>
                    <th>Loan</th>
                    <th>Borrower</th>
                    <th>Amount</th>
                    <th>Deadline</th>
                    <th>Days past</th>
                    <th>Officer</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stuckPromises.map((row) => (
                    <tr key={row.promiseId}>
                      <td className="num">{row.loanId}</td>
                      <td>{row.borrowerName}</td>
                      <td className="num">{formatLakhCrore(row.amountPaise / 100)}</td>
                      <td className="num">{row.deadline}</td>
                      <td className="num">{row.daysPastDue}</td>
                      <td>{row.officerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="footnote">Broken promises 2+ days past their deadline with no officer contact since the break (A62). Read-only here; the escalation ladder lives with the officer. Synthetic data.</p>
          </section>
        </>
      ) : null}
    </main>
  );
}
