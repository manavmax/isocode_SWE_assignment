import { useCallback, useEffect, useState } from 'react';
import { api, type ApiUser } from '../api.js';
import {
  clearCache,
  ensurePersistence,
  getLastSyncAt,
  getOutboxItems,
  getOutboxCounts,
  retryItem,
  discardItem,
  type OutboxItem
} from '../dexie/db.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { syncNow } from '../sync/scheduler.js';

export function Me({ lang, setLang, user, onLoggedOut }: { lang: Lang; setLang: (lang: Lang) => void; user: ApiUser | null; onLoggedOut: () => void }) {
  const tr = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  const [counts, setCounts] = useState({ pending: 0, failed: 0, synced: 0 });
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);

  const loadOutbox = useCallback(async () => {
    const [c, i, sync, pers] = await Promise.all([
      getOutboxCounts(),
      getOutboxItems(),
      getLastSyncAt(),
      // SPEC 6 platform limits: request persistence once data exists and
      // remember the browser's answer; warn while pending and not granted.
      ensurePersistence()
    ]);
    setCounts(c);
    setItems(i);
    setLastSync(sync);
    setPersisted(pers);
  }, []);

  useEffect(() => {
    void (async () => {
      await loadOutbox();
    })();
  }, [loadOutbox]);

  async function handleSyncNow() {
    setSyncing(true);
    await syncNow();
    await loadOutbox();
    setSyncing(false);
  }

  async function handleRetry(id: string) {
    await retryItem(id);
    await loadOutbox();
  }

  async function handleDiscard(id: string) {
    await discardItem(id);
    await loadOutbox();
  }

  async function handleLogout(): Promise<void> {
    await api.logout();
    try {
      await clearCache();
    } finally {
      onLoggedOut();
    }
  }

  function formatSyncTime(ts: number | null): string {
    if (!ts) return '—';
    const p = new Date(ts);
    return `${String(p.getHours()).padStart(2, '0')}:${String(p.getMinutes()).padStart(2, '0')} · ${p.toLocaleDateString()}`;
  }

  function itemChip(item: OutboxItem): string {
    if (item.state === 'synced') return tr('stateSynced');
    if (item.state === 'failed') return tr('stateFailed');
    return tr('statePending');
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{tr('meTitle')}</h1>
      </header>

      {/* Sync section (SPEC 2 screen 5) */}
      <section className="sync-section">
        <div className="sync-header">
          <span className="section-label" style={{ margin: 0 }}>{tr('syncTitle')}</span>
          <button
            type="button"
            className={`btn btn-secondary sync-now-btn ${syncing ? 'btn-loading' : ''}`}
            onClick={() => void handleSyncNow()}
            disabled={syncing}
          >
            {syncing ? tr('syncing') : tr('syncNow')}
          </button>
        </div>

        <div className="sync-counts">
          <SyncCount label={tr('syncPending')} value={counts.pending} chip="pending" />
          <SyncCount label={tr('syncFailed')} value={counts.failed} chip="failed" />
          <SyncCount label={tr('syncSynced')} value={counts.synced} chip="synced" />
        </div>

        {counts.pending > 0 && (
          <p className="sync-note">{tr('syncPendingNote')}</p>
        )}

        {items.length > 0 ? (
          <div className="outbox-list">
            {items.slice(0, 30).map((item) => (
              <div key={item.id} className={`outbox-item outbox-item-${item.state}`}>
                <div className="outbox-item-row">
                  <span className="outbox-id">{item.payload.outcome}</span>
                  <span className={`outbox-chip outbox-chip-${item.state}`}>{itemChip(item)}</span>
                </div>
                {item.lastError && (
                  <p className="outbox-error">{item.lastError}</p>
                )}
                {item.warnings?.map((w, i) => (
                  <p key={i} className="outbox-warning">{w.code}: {w.reason}</p>
                ))}
                {item.state === 'failed' && (
                  <div className="outbox-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleRetry(item.id)}
                    >
                      {tr('retry')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-danger"
                      onClick={() => void handleDiscard(item.id)}
                    >
                      {tr('discard')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="sync-empty">{tr('syncEmpty')}</p>
        )}

        <p className="sync-last">{tr('syncLast')}: {formatSyncTime(lastSync)}</p>

        {counts.pending > 0 && persisted === false && (
          <p className="persist-warn">{tr('persistWarn')}</p>
        )}
        {persisted === true && (
          <p className="persist-ok">{tr('persistOk')}</p>
        )}
      </section>

      <p className="section-label">{tr('meAccount')}</p>
      <div className="facts">
        <div className="fact-row">
          <span className="fact-label">{tr('loginUsername')}</span>
          <span className="fact-value">{user ? user.username : '—'}</span>
        </div>
        <div className="fact-row">
          <span className="fact-label">{tr('factStatus')}</span>
          <span className="fact-value">{user ? user.role : '—'}</span>
        </div>
      </div>

      <p className="section-label">{tr('meLanguage')}</p>
      <div className="login-lang" role="group" aria-label={tr('meLanguage')}>
        <button type="button" className="btn" aria-pressed={lang === 'hi'} onClick={() => setLang('hi')}>
          हिंदी
        </button>
        <button type="button" className="btn" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
          English
        </button>
      </div>

      <p className="screen-subtitle" style={{ margin: 'var(--sp-3) 0' }}>
        {tr('meOfflineCache')}
      </p>

      <button type="button" className="btn btn-secondary" style={{ color: 'var(--status-danger)', borderColor: 'var(--status-danger)' }} onClick={() => void handleLogout()}>
        {tr('meLogout')}
      </button>
    </main>
  );
}

function SyncCount({ label, value, chip }: { label: string; value: number; chip: string }) {
  return (
    <div className="sync-count">
      <span className="sync-count-value">{value}</span>
      <span className={`sync-count-chip sync-count-chip-${chip}`}>{label}</span>
    </div>
  );
}
