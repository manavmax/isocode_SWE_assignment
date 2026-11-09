import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api, type ManagerDashboardDto } from '../api.js';
import { formatDayMonth, formatMoneyShort } from '../format.js';
import { ErrorState, SkeletonList } from '../components/States.js';
import { ResponsiveTable } from '../components/ResponsiveTable.js';

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

/** Collapsed methodology note (prompt 20 item 15): one "How this is
 *  calculated" disclosure per card, closed by default, 12px body. */
function HowCalc({ children }: { children: ReactNode }) {
  return (
    <details className="how-disclosure">
      <summary>How this is calculated</summary>
      <p className="footnote">{children}</p>
    </details>
  );
}

/** Dot-column trend (prompt 20 item 5): the last 12 COMPLETED windows, one
 *  column per window, filled dots proportional to the roll % (one dot per
 *  5 points), a dashed row at the 16% target labelled on the chart, and
 *  "d MMM" x labels under every 3rd column — each label its own element.
 *  Hand-rolled, no chart library. */
function DotColumnChart({ trend }: { trend: { t0: string; t1: string; rollRateCount: number | null }[] }) {
  const completed = trend.filter((point) => point.rollRateCount !== null).slice(-12);
  if (completed.length < 2) {
    return <p className="screen-subtitle">Not enough completed windows for a trend yet.</p>;
  }
  const DOTS = 12;
  const STEP = 0.05; // one dot per 5 percentage points
  const markerRow = Math.round(0.16 / STEP); // target row, counted from the bottom
  return (
    <div className="dotcolumn" role="img" aria-label="Roll rate trend: one dot column per completed window, dashed marker at the 16 percent target">
      <div className="dotcolumn-plot">
        {completed.map((point) => {
          const rate = point.rollRateCount as number;
          const filled = Math.min(DOTS, Math.round(rate / STEP));
          return (
            <div key={point.t0} className="dotcolumn-col" title={`${point.t0}: ${(rate * 100).toFixed(1)}%`}>
              {Array.from({ length: DOTS }, (_, i) => (
                <span key={i} className={i < filled ? 'filled' : ''} />
              ))}
            </div>
          );
        })}
        <div className="dotcolumn-marker" style={{ '--row': DOTS - 1 - markerRow } as CSSProperties}>
          <span className="dotcolumn-marker-label num">16% target</span>
        </div>
      </div>
      <div className="dotcolumn-x num" aria-hidden="true">
        {completed.map((point, i) => (
          <span key={point.t0}>{i % 3 === 2 ? formatDayMonth(point.t0.slice(0, 10), 'en') : ''}</span>
        ))}
      </div>
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
        <button type="button" className="topbar-icon icon-button" aria-label="Refresh" onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
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
              <div className="tile mesh-b1" data-hero>
                <span className="tile-label">Roll B1→B2, count (target 16%)</span>
                <span className="tile-value num">{pct(data.tiles.rollRateCount)}</span>
                <span className="tile-label">{data.tiles.loansToSave} loans to save</span>
              </div>
              <div className="tile mesh-b2" data-hero>
                <span className="tile-label">Roll B1→B2, balance</span>
                <span className="tile-value num">{pct(data.tiles.rollRateAmount)}</span>
                <span className="tile-label">of {formatMoneyShort(data.tiles.cohortAmt)} cohort</span>
              </div>
              <div className="tile mesh-b4" data-hero>
                <span className="tile-label">Promises kept</span>
                <span className="tile-value num">
                  {data.keptRate === null ? '—' : pct(data.keptRate)} <span className="tile-unit">({data.keptMade} settled)</span>
                </span>
                <span className="tile-label">{data.openBrokenPromises} open broken</span>
              </div>
            </div>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="tile-label">Queued loans (branch)</span>
                <span className="stat-value num">{data.queueCount}</span>
                <span className="stat-caption">Loans parked for a data fix — unmapped pincode, or no phone and no address.</span>
                <HowCalc>Queue = branch loans with status &lsquo;queue&rsquo;: the daily import could not assign them to an officer (unmapped pincode, or no phone AND no address). Synthetic data.</HowCalc>
              </div>
              <div className="stat-card">
                <span className="tile-label">Blocked attempts, 30 days</span>
                <span className="stat-value num">{data.blockedAttempts30d}</span>
                <span className="stat-caption">Contact attempts outside the 08:00&ndash;19:00 IST window &mdash; recorded, never sent.</span>
                <HowCalc>Count of BLOCKED contact events on branch loans in the last 30 IST days (SPEC 7: a violation is recorded, never discarded). Synthetic data.</HowCalc>
              </div>
            </div>
            </>
          )}
          <HowCalc>
            {data.tiles
              ? `Counts: ${data.tiles.rolledN} rolled of ${data.tiles.cohortN} cohort loans. Balances: ${formatMoneyShort(data.tiles.rolledAmt)} rolled of ${formatMoneyShort(data.tiles.cohortAmt)}. Wilson 95%: ${data.tiles.wilson ? `${pct(data.tiles.wilson.low)}–${pct(data.tiles.wilson.high)}` : 'n/a'}. ${footnote}`
              : footnote}
          </HowCalc>

          <section className="panel detail-card" data-section="chart">
            <h2 className="panel-title">Roll-rate trend ({data.trendWindowsAvailable} completed windows)</h2>
            <DotColumnChart trend={data.trend} />
            <HowCalc>{footnote}</HowCalc>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Migration table (latest completed window)</h2>
            <MigrationBars rows={data.migrationTable} />
            <HowCalc>Rows: opening DPD bucket at the window start. Shares of the opening cohort: cured (left the book or DPD 0), stayed (same bucket), rolled (next bucket up). Sum to 1 per row. Synthetic data.</HowCalc>
          </section>

          <section className="panel detail-card" data-section="tables">
            <h2 className="panel-title">Officers (roll rate by opening attribution)</h2>
            <ResponsiveTable
              headers={
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
              }
              rows={
                <tbody>
                  {data.officerTable.map((row) => (
                    <tr key={row.officerId} className={row.greyedOut ? 'greyed' : ''}>
                      <td className="cell-name">{row.officerName}</td>
                      <td className="num">{row.cohortN}</td>
                      <td className="num">{row.rolledN}</td>
                      <td className="cell-key num">{pct(row.cohortN > 0 ? row.rollRate : null)}</td>
                      <td className="num">{row.wilson ? `${pct(row.wilson.low)}–${pct(row.wilson.high)}` : '—'}</td>
                      <td className="num">{row.keptRate === null ? '—' : pct(row.keptRate)}</td>
                      <td className="num">{row.workload}</td>
                      <td className="cell-action">
                        <button type="button" className="btn btn-ghost" onClick={() => onOpenActivity(row.officerId)}>
                          Last 50 events
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              }
              cards={data.officerTable.map((row) => ({
                key: row.officerId,
                name: row.officerName,
                keyNum: pct(row.cohortN > 0 ? row.rollRate : null),
                greyed: row.greyedOut,
                chips: [
                  `n=${row.cohortN} · rolled ${row.rolledN}`,
                  row.wilson ? `Wilson ${pct(row.wilson.low)}–${pct(row.wilson.high)}` : 'Wilson —',
                  `kept ${row.keptRate === null ? '—' : pct(row.keptRate)} · load ${row.workload}`
                ],
                action: (
                  <button type="button" className="btn btn-ghost" onClick={() => onOpenActivity(row.officerId)}>
                    Last 50 events
                  </button>
                )
              }))}
            />
            <HowCalc>Greyed rows have n &lt; 30 (SPEC 13). Kept rate = kept / (kept + broken + broken_part) over the officer's own promises. Workload = currently assigned overdue loans. Synthetic data.</HowCalc>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Broken promises (oldest break first)</h2>
            {data.brokenPromises.length === 0 ? (
              <p className="screen-subtitle">None — nothing to escalate.</p>
            ) : (
              <ResponsiveTable
                headers={
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
                }
                rows={
                  <tbody>
                    {data.brokenPromises.map((row) => (
                      <tr key={row.promiseId}>
                        <td className="num">{row.loanId}</td>
                        <td className="cell-name">{row.borrowerName}</td>
                        <td className="cell-key num">{formatMoneyShort(row.amountPaise)}</td>
                        <td className="num">{row.ageDays} d</td>
                        <td>{row.officerName ?? '—'}</td>
                        <td className="cell-action">
                          <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                            {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                }
                cards={data.brokenPromises.map((row) => ({
                  key: row.promiseId,
                  name: row.borrowerName,
                  keyNum: formatMoneyShort(row.amountPaise),
                  chips: [row.loanId, `broke ${row.ageDays} d ago`, row.officerName ?? '—'],
                  action: (
                    <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                      {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                    </button>
                  )
                }))}
              />
            )}
            <HowCalc>Amount = the promised amount (paise to lakh/crore). Age = days since the break was recorded. Pin sends the loan to the top of its officer's Today list. Synthetic data.</HowCalc>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Exceptions: 25–30 DPD, no promise, no contact in 5 days</h2>
            {data.exceptions.length === 0 ? (
              <p className="screen-subtitle">No exceptions today.</p>
            ) : (
              <ResponsiveTable
                headers={
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
                }
                rows={
                  <tbody>
                    {data.exceptions.map((row) => (
                      <tr key={row.loanId}>
                        <td className="num">{row.loanId}</td>
                        <td className="cell-name">{row.borrowerName}</td>
                        <td className="num">{row.dpd}</td>
                        <td className="cell-key num">{formatMoneyShort(row.overdueAmount)}</td>
                        <td>{row.officerName ?? '—'}</td>
                        <td className="cell-action">
                          <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                            {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                }
                cards={data.exceptions.map((row) => ({
                  key: row.loanId,
                  name: row.borrowerName,
                  keyNum: formatMoneyShort(row.overdueAmount),
                  chips: [row.loanId, `DPD ${row.dpd}`, row.officerName ?? '—'],
                  action: (
                    <button type="button" className="btn btn-secondary" disabled={pinBusy === row.loanId || row.officerName === null} onClick={() => void pin(row.loanId, row.officerName)}>
                      {pinBusy === row.loanId ? '…' : pinDone === row.loanId ? 'Pinned' : 'Pin to top'}
                    </button>
                  )
                }))}
              />
            )}
            <HowCalc>Numerator: branch loans 25–30 DPD with no open promise and no CALL/VISIT/MESSAGE in the last 5 IST days. Denominator: the branch overdue book. Synthetic data.</HowCalc>
          </section>

          <section className="panel detail-card">
            <h2 className="panel-title">Stuck promises (nightly list)</h2>
            {data.stuckPromises.length === 0 ? (
              <p className="screen-subtitle">No stuck promises — nothing 2+ days past due without action.</p>
            ) : (
              <ResponsiveTable
                headers={
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
                }
                rows={
                  <tbody>
                    {data.stuckPromises.map((row) => (
                      <tr key={row.promiseId}>
                        <td className="num">{row.loanId}</td>
                        <td className="cell-name">{row.borrowerName}</td>
                        <td className="cell-key num">{formatMoneyShort(row.amountPaise)}</td>
                        <td className="num">{formatDayMonth(row.deadline, 'en')}</td>
                        <td className="num">{row.daysPastDue}</td>
                        <td>{row.officerName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                }
                cards={data.stuckPromises.map((row) => ({
                  key: row.promiseId,
                  name: row.borrowerName,
                  keyNum: formatMoneyShort(row.amountPaise),
                  chips: [row.loanId, formatDayMonth(row.deadline, 'en'), `${row.daysPastDue} d past`, row.officerName ?? '—']
                }))}
              />
            )}
            <HowCalc>Broken promises 2+ days past their deadline with no officer contact since the break (A62). Read-only here; the escalation ladder lives with the officer. Synthetic data.</HowCalc>
          </section>
        </>
      ) : null}
    </main>
  );
}
