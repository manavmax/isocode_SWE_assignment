import { useCallback, useEffect, useState } from 'react';
import { api, type ActivityRowDto } from '../api.js';
import { formatIstTime } from '../../shared/datetime.js';
import { ErrorState, OfflineBanner, SkeletonList } from '../components/States.js';

/**
 * Manager view of an officer's last 50 contact events (prompt 13 item 4).
 * English only (A67). Read-only table: IST time, loan, outcome, window
 * flag, violation badge, GPS status and accuracy. No map.
 */

type Load = 'loading' | 'ready' | 'error';

/**
 * layout contract ("activity"): top-bar -> table (the officer's last 50 events).
 */
export function OfficerActivity({ officerId, onBack }: { officerId: string; onBack: () => void }) {
  const [load, setLoad] = useState<Load>('loading');
  const [rows, setRows] = useState<ActivityRowDto[]>([]);
  const [offline, setOffline] = useState(false);
  const [officerName, setOfficerName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOffline(false);
    // The Activity tile routes carry the sentinel 'first' (no officer is
    // selected there): default to the first officer of the manager's branch.
    let target = officerId;
    if (target === 'first') {
      const dash = await api.managerDashboard();
      if (!dash.ok) {
        setOffline(dash.error.kind === 'network');
        setLoad('error');
        return;
      }
      const first = dash.data.officerTable[0];
      if (!first) {
        setLoad('error');
        return;
      }
      target = first.officerId;
      setOfficerName(first.officerName);
    }
    const result = await api.officerActivity(target);
    if (result.ok) {
      setRows(result.data.activity);
      setLoad('ready');
    } else if (result.error.kind === 'network') {
      setOffline(true);
      setLoad('error');
    } else {
      setLoad('error');
    }
  }, [officerId]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  return (
    <main className="screen manager-screen">
      <div className="topbar" data-section="top-bar">
        <button type="button" className="topbar-icon icon-button" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <span className="topbar-title">{officerName ? `Activity · ${officerName}` : 'Activity'}</span>
        <span className="topbar-spacer" aria-hidden="true" />
      </div>
      {offline ? <OfflineBanner text="You're offline. Showing the last loaded data only." /> : null}
      {load === 'loading' ? <SkeletonList rows={6} /> : null}
      {load === 'error' ? (
        <ErrorState title="Couldn't reach server" body="Check your connection and try again." onRetry={() => void refresh()} retryLabel="Retry" />
      ) : null}
      {load === 'ready' ? (
        rows.length === 0 ? (
          <p className="screen-subtitle">No contact events for this officer yet.</p>
        ) : (
          <table className="manager-table" data-cards data-section="table">
            <thead>
              <tr>
                <th>Loan</th>
                <th>When (IST)</th>
                <th>Kind</th>
                <th>Outcome</th>
                <th>Window</th>
                <th>GPS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.eventId}>
                  <td className="cell-name num">{row.loanId}</td>
                  <td className="cell-key num">{formatIstTime(Date.parse(row.attemptedAtIst))}</td>
                  <td>{row.kind}</td>
                  <td>{row.outcome ?? '—'}</td>
                  <td>
                    {row.complianceStatus === 'VIOLATION_DETECTED' ? (
                      <span className="chip chip-warn">Violation</span>
                    ) : (
                      <span className="chip">{row.withinWindow ? 'In window' : 'Out'}</span>
                    )}
                  </td>
                  <td className="num">
                    {row.gpsStatus ?? '—'}
                    {row.accuracyM !== null ? ` ±${row.accuracyM}m` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      <p className="footnote">Read-only. Time shown is the skew-corrected attempt instant in IST. Window flag: 08:00–19:00 IST contact rule; a violation is recorded, never discarded (SPEC 7). GPS: device accuracy at the attempt. Synthetic data.</p>
    </main>
  );
}
