import { useCallback, useEffect, useState } from 'react';
import { api, type BatchRowDto, type ImportReportDto, type QueueLoanDto } from '../api.js';
import { formatDayMonth, formatMoneyShort } from '../format.js';
import { ErrorState, OfflineBanner, SkeletonList } from '../components/States.js';
import { ResponsiveTable } from '../components/ResponsiveTable.js';

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
        <button type="button" className="topbar-icon icon-button" aria-label="Refresh" onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
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
        <div className="import-field">
          <span className="import-label-text">CSV file</span>
          {/* the real input stays for a11y — visually replaced by the drop zone */}
          <label className={`dropzone${file ? ' dropzone-has-file' : ''}`}>
            <input
              type="file"
              accept=".csv,text/csv"
              className="dropzone-input"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <span className="dropzone-file">
                <span className="dropzone-name">{file.name}</span>
                <span className="dropzone-size num">{file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`}</span>
              </span>
            ) : (
              <span className="dropzone-hint">Choose CSV file</span>
            )}
          </label>
        </div>
        <label className="import-label">
          As-of date
          <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
        </label>
        <button type="button" className="btn btn-primary btn-block" disabled={uploading || !file} onClick={() => void upload()}>
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
          <dl className="report-grid">
            <div className="report-pair"><dt>Read</dt><dd className="num">{report.totalRows}</dd></div>
            <div className="report-pair"><dt>Imported</dt><dd className="num">{report.imported}</dd></div>
            <div className="report-pair"><dt>New</dt><dd className="num">{report.new}</dd></div>
            <div className="report-pair"><dt>Updated (aging)</dt><dd className="num">{report.aging}</dd></div>
            <div className="report-pair"><dt>Part paid</dt><dd className="num">{report.partPaid}</dd></div>
            <div className="report-pair"><dt>Anomalous</dt><dd className="num">{report.anomalous}</dd></div>
            <div className="report-pair"><dt>Gone (cleared)</dt><dd className="num">{report.gone}</dd></div>
            <div className="report-pair"><dt>Unchanged</dt><dd className="num">{Math.max(0, report.totalRows - report.new - report.aging - report.partPaid - report.anomalous)}</dd></div>
            <div className="report-pair"><dt>Skipped (DPD 0)</dt><dd className="num">{report.skipped}</dd></div>
            <div className="report-pair"><dt>Dropped</dt><dd className="num">{report.dropped}</dd></div>
            <div className="report-pair"><dt>Errors</dt><dd className="num">{report.errors}</dd></div>
            <div className="report-pair"><dt>Warnings</dt><dd className="num">{report.warnings}</dd></div>
            {report.paymentsInferred !== undefined ? (
              <div className="report-pair"><dt>Payments inferred</dt><dd className="num">{report.paymentsInferred}</dd></div>
            ) : null}
          </dl>
          <h3 className="panel-title">Assignment outcomes by reason</h3>
          <dl className="report-grid report-two">
            {Object.entries(report.assignment).map(([reason, count]) => (
              <div key={reason} className="report-pair">
                <dt>{REASON_LABELS[reason] ?? reason}</dt>
                <dd className="num">{count}</dd>
              </div>
            ))}
          </dl>
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
          <ResponsiveTable
            headers={
              <thead>
                <tr><th>Loan</th><th>Borrower</th><th>DPD</th><th>Overdue</th><th>Pincode</th><th>Reason</th></tr>
              </thead>
            }
            rows={
              <tbody>
                {queue.map((row) => (
                  <tr key={row.loanId}>
                    <td className="num">{row.loanId}</td>
                    <td className="cell-name">{row.borrowerName}</td>
                    <td className="num">{row.dpd}</td>
                    <td className="cell-key num">{formatMoneyShort(row.overdueAmount)}</td>
                    <td className="num">{row.pincode ?? '—'}</td>
                    <td>{row.reason === 'unmapped_pincode' ? 'Unmapped pincode (no territory row)' : 'Data fix: no phone AND no address'}</td>
                  </tr>
                ))}
              </tbody>
            }
            cards={queue.map((row) => ({
              key: row.loanId,
              name: row.borrowerName,
              keyNum: formatMoneyShort(row.overdueAmount),
              chips: [
                row.loanId,
                `DPD ${row.dpd} · ${row.pincode ?? 'pincode —'}`,
                row.reason === 'unmapped_pincode' ? 'Unmapped pincode' : 'Data fix: no phone AND no address'
              ]
            }))}
          />
        )}
        <p className="footnote">A24: unrouted newly-imported loans queue for the branch manager. Reason is derived from the data: no territory row for the pincode, or the row had no usable phone and no address. Synthetic data.</p>
      </section>

      <section className="panel detail-card" data-section="batches">
        <h2 className="panel-title">Past batches</h2>
        {batches.length === 0 ? (
          <SkeletonList rows={2} />
        ) : (
          <ResponsiveTable
            headers={
              <thead>
                <tr><th>As-of</th><th>File</th><th>Status</th><th>Rows</th><th>Errors</th><th>Warnings</th><th>errors.csv</th></tr>
              </thead>
            }
            rows={
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.batchId}>
                    <td className="num">{formatDayMonth(batch.asOf, 'en')}</td>
                    <td className="cell-name">{batch.filename}</td>
                    <td>{batch.status}</td>
                    <td className="cell-key num">{batch.totalRows}</td>
                    <td className="num">{batch.errors}</td>
                    <td className="num">{batch.warnings}</td>
                    <td className="cell-action">
                      <a className="btn btn-ghost" href={`/api/import/${batch.batchId}/errors.csv`}>Download</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            }
            cards={batches.map((batch) => ({
              key: batch.batchId,
              name: batch.filename,
              keyNum: String(batch.totalRows),
              chips: [formatDayMonth(batch.asOf, 'en'), batch.status, `errors ${batch.errors} · warnings ${batch.warnings}`],
              action: (
                <a className="btn btn-ghost" href={`/api/import/${batch.batchId}/errors.csv`}>Download errors.csv</a>
              )
            }))}
          />
        )}
        <p className="footnote">Immutable batches keyed by (as-of, sha-256). Same bytes = no-op replay; same date with different bytes = replace. Synthetic data.</p>
      </section>
    </main>
  );
}
