import { useCallback, useEffect, useState } from 'react';
import { api, type BatchRowDto, type ImportReportDto, type QueueLoanDto } from '../api.js';
import { ErrorState, OfflineBanner, SkeletonList } from '../components/States.js';

/**
 * Manager import screen (SPEC 11, prompt 13 item 5). English only (A67).
 * Choose a CSV + as-of (default: the last working IST day), upload through
 * POST /api/import, show the full report with assignment outcomes by
 * reason, the errors.csv download, the queued loans with their reason, and
 * the past batches. Aborts get a plain-language message.
 */

type Load = 'ready' | 'error';

/** The last working IST day: step back from today, skipping Sundays. */
function lastWorkingDay(): string {
  const day = new Date();
  let candidate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 86_400_000);
  for (let i = 0; i < 7 && candidate.getUTCDay() === 0; i += 1) {
    candidate = new Date(candidate.getTime() - 86_400_000);
  }
  return candidate.toISOString().slice(0, 10);
}

const REASON_LABELS: Record<string, string> = {
  carry_forward: 'Carried forward (still overdue)',
  stays_61plus: 'Stays 61+ DPD',
  new_assigned: 'Newly assigned',
  reassigned_score: 'Reassigned (score)',
  reassigned_inactive: 'Reassigned (inactive officer)',
  reassigned_leave: 'Reassigned (leave cover)',
  reassigned_out_of_territory: 'Reassigned (out of territory)',
  revert_return: 'Reverted on officer return',
  queue_unmapped: 'Queued: unmapped pincode',
  queue_data_fix: 'Queued: data fix (no phone AND no address)'
};

/**
 * layout contract ("import"): top-bar -> segmented -> upload -> queue -> batches ->
 * nav (floating pill).
 */
export function ManagerImport({ onOpenOverview, onOpenActivityRoute }: { onOpenOverview: () => void; onOpenActivityRoute: () => void }) {
  const [load, setLoad] = useState<Load>('ready');
  const [asOf, setAsOf] = useState<string>(lastWorkingDay());
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<ImportReportDto | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [abort, setAbort] = useState<{ code: string; message: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueLoanDto[]>([]);
  const [batches, setBatches] = useState<BatchRowDto[]>([]);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    const queueResult = await api.managerQueue();
    if (queueResult.ok) {
      setQueue(queueResult.data.queue);
    } else if (queueResult.error.kind === 'network') {
      setOffline(true);
    } else if (queueResult.error.kind === 'unauthorized') {
      window.location.assign('/login');
      return;
    }
    const batchResult = await api.importBatches();
    if (batchResult.ok) {
      setBatches(batchResult.data.batches);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  async function upload(): Promise<void> {
    if (!file) {
      setMessage('Choose a CSV file first.');
      return;
    }
    setUploading(true);
    setReport(null);
    setAbort(null);
    setBatchId(null);
    setMessage(null);
    const form = new FormData();
    form.append('file', file);
    form.append('as_of', asOf);
    const result = await api.uploadImport(form);
    setUploading(false);
    if (result.ok) {
      if (result.data.status === 'rejected' && result.data.abort) {
        setAbort(result.data.abort);
      } else {
        setReport(result.data.report ?? null);
        setBatchId(result.data.batchId ?? null);
      }
      await refresh();
    } else if (result.error.kind === 'unauthorized') {
      window.location.assign('/login');
    } else if (result.error.kind === 'forbidden') {
      setMessage('Only branch managers can import.');
    } else if (result.error.kind === 'throttled') {
      setMessage('Too many uploads in a row — wait a minute and retry.');
    } else {
      setMessage('Upload failed — check your connection and retry.');
    }
  }

  if (load === 'error') {
    return (
      <main className="screen manager-screen">
        <h1 className="screen-title">Import</h1>
        <ErrorState title="Couldn't reach server" body="Check your connection and try again." onRetry={() => setLoad('ready')} retryLabel="Retry" />
      </main>
    );
  }

  return (
    <main className="screen manager-screen">
      <div className="topbar" data-section="top-bar">
        <span className="topbar-spacer" aria-hidden="true" />
        <span className="topbar-title">Import</span>
        <button type="button" className="topbar-icon" aria-label="Refresh" onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
          </svg>
        </button>
      </div>
      <h1 className="screen-title">Daily CSV import</h1>
      <nav className="manager-seg" aria-label="Manager sections" data-section="segmented">
        <button type="button" onClick={onOpenOverview}>Overview</button>
        <button type="button" aria-current="page" onClick={() => undefined}>Import</button>
        <button type="button" onClick={onOpenActivityRoute}>Activity</button>
      </nav>
      {offline ? <OfflineBanner text="You're offline. Uploads need a connection." /> : null}
      <p className="screen-subtitle">Full list of every loan with DPD &ge; 1 for the date. Re-importing the same file is a no-op; the same date with different bytes replaces it.</p>

      <div className="import-form" data-section="upload">
        <label className="import-label">
          CSV file
          <input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <label className="import-label">
          As-of date
          <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" disabled={uploading} onClick={() => void upload()}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {message ? <p className="footnote">{message}</p> : null}

      {abort ? (
        <div className="abort-box">
          <strong>Import aborted — nothing was written.</strong>
          <p>
            {abort.code}: {abort.message}
          </p>
        </div>
      ) : null}

      {report ? (
        <section className="panel">
          <h2 className="panel-title">Import report {batchId ? `(batch ${batchId.slice(0, 8)})` : ''}</h2>
          <table className="manager-table">
            <tbody>
              <tr><th>Read</th><td className="num">{report.totalRows}</td><th>Imported</th><td className="num">{report.imported}</td></tr>
              <tr><th>New</th><td className="num">{report.new}</td><th>Updated (aging)</th><td className="num">{report.aging}</td></tr>
              <tr><th>Part paid</th><td className="num">{report.partPaid}</td><th>Anomalous</th><td className="num">{report.anomalous}</td></tr>
              <tr><th>Gone (cleared)</th><td className="num">{report.gone}</td><th>Unchanged</th><td className="num">{Math.max(0, report.totalRows - report.new - report.aging - report.partPaid - report.anomalous)}</td></tr>
              <tr><th>Skipped (DPD 0)</th><td className="num">{report.skipped}</td><th>Dropped</th><td className="num">{report.dropped}</td></tr>
              <tr><th>Errors</th><td className="num">{report.errors}</td><th>Warnings</th><td className="num">{report.warnings}</td></tr>
              {report.paymentsInferred !== undefined ? (
                <tr><th>Payments inferred</th><td className="num">{report.paymentsInferred}</td><th /><td /></tr>
              ) : null}
            </tbody>
          </table>
          <h3 className="panel-title">Assignment outcomes by reason</h3>
          <table className="manager-table">
            <tbody>
              {Object.entries(report.assignment).map(([reason, count]) => (
                <tr key={reason}>
                  <th>{REASON_LABELS[reason] ?? reason}</th>
                  <td className="num">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {batchId ? (
            <p>
              <a className="btn btn-ghost" href={`/api/import/${batchId}/errors.csv`}>Download errors.csv</a>
            </p>
          ) : null}
          <p className="footnote">Read = rows in the file. Imported = written to the book. Updated = continuing loans re-classified. Unchanged = continuing with no change. Skipped = DPD 0. Assignment outcomes come from the real planner run after the import. Synthetic data.</p>
        </section>
      ) : null}

      <section className="panel detail-card" data-section="queue">
        <h2 className="panel-title">Queued loans and why ({queue.length})</h2>
        {queue.length === 0 ? (
          <p className="screen-subtitle">Nothing queued for this branch.</p>
        ) : (
          <table className="manager-table">
            <thead>
              <tr><th>Loan</th><th>Borrower</th><th>DPD</th><th>Overdue</th><th>Pincode</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.loanId}>
                  <td className="num">{row.loanId}</td>
                  <td>{row.borrowerName}</td>
                  <td className="num">{row.dpd}</td>
                  <td className="num">{row.overdueAmount / 100}</td>
                  <td className="num">{row.pincode ?? '—'}</td>
                  <td>{row.reason === 'unmapped_pincode' ? 'Unmapped pincode (no territory row)' : 'Data fix: no phone AND no address'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="footnote">A24: unrouted newly-imported loans queue for the branch manager. Reason is derived from the data: no territory row for the pincode, or the row had no usable phone and no address. Synthetic data.</p>
      </section>

      <section className="panel detail-card" data-section="batches">
        <h2 className="panel-title">Past batches</h2>
        {batches.length === 0 ? (
          <SkeletonList rows={2} />
        ) : (
          <table className="manager-table">
            <thead>
              <tr><th>As-of</th><th>File</th><th>Status</th><th>Rows</th><th>Errors</th><th>Warnings</th><th>errors.csv</th></tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.batchId}>
                  <td className="num">{batch.asOf}</td>
                  <td>{batch.filename}</td>
                  <td>{batch.status}</td>
                  <td className="num">{batch.totalRows}</td>
                  <td className="num">{batch.errors}</td>
                  <td className="num">{batch.warnings}</td>
                  <td>
                    <a className="btn btn-ghost" href={`/api/import/${batch.batchId}/errors.csv`}>Download</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="footnote">Immutable batches keyed by (as-of, sha-256). Same bytes = no-op replay; same date with different bytes = replace. Synthetic data.</p>
      </section>
    </main>
  );
}
