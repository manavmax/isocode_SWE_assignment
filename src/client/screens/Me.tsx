import { api, type ApiUser } from '../api.js';
import { clearCache } from '../dexie/db.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';

export function Me({ lang, setLang, user, onLoggedOut }: { lang: Lang; setLang: (lang: Lang) => void; user: ApiUser | null; onLoggedOut: () => void }) {
  const tr = (key: Parameters<typeof translate>[1]) => translate(lang, key);

  async function logout(): Promise<void> {
    await api.logout();
    try {
      await clearCache();
    } finally {
      onLoggedOut();
    }
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{tr('meTitle')}</h1>
      </header>

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

      <button type="button" className="btn btn-secondary" style={{ color: 'var(--status-danger)', borderColor: 'var(--status-danger)' }} onClick={() => void logout()}>
        {tr('meLogout')}
      </button>
    </main>
  );
}
