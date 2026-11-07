import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { t as translate, type Lang } from '../i18n/dictionary.js';
import { loginErrorMessage, loginErrorKind, type LoginErrorKind } from './loginError.js';

export function Login({ lang, setLang, onSignedIn, sessionExpired }: { lang: Lang; setLang: (lang: Lang) => void; onSignedIn: () => void; sessionExpired?: boolean }) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [demoUsernames, setDemoUsernames] = useState<string[]>([]);
  const [error, setError] = useState<{ kind: LoginErrorKind; retryAfterSeconds?: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.demoAccounts().then((result) => {
      if (!cancelled && result.ok && result.data.usernames.length > 0) {
        setDemoUsernames(result.data.usernames);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tr = (key: Parameters<typeof translate>[1]) => translate(lang, key);

  async function submit(): Promise<void> {
    if (submitting || username.length === 0 || pin.length === 0) return;
    setSubmitting(true);
    setError(null);
    const result = await api.login(username.trim(), pin);
    setSubmitting(false);
    if (result.ok) {
      onSignedIn();
      return;
    }
    setError({ kind: loginErrorKind(result.error), retryAfterSeconds: result.error.retryAfterSeconds });
  }

  return (
    <main className="screen">
      <h1 className="screen-title">{tr('appName')}</h1>
      <div className="login-lang" role="group" aria-label={tr('loginLanguageLabel')}>
        <button type="button" className="btn" aria-pressed={lang === 'hi'} onClick={() => setLang('hi')}>
          हिंदी
        </button>
        <button type="button" className="btn" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
          English
        </button>
      </div>
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="username">
            {tr('loginUsername')}
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pin">
            {tr('loginPin')}
          </label>
          <input
            id="pin"
            name="pin"
            type="text"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
          />
        </div>
        {error !== null ? (
          <p className="state-body" role="alert" style={{ color: 'var(--status-danger)' }}>
            {loginErrorMessage(error.kind, lang, error.retryAfterSeconds)}
          </p>
        ) : null}
        {sessionExpired ? (
          <p className="state-body" role="alert" style={{ color: 'var(--status-warn)' }}>
            {tr('sessionExpired')}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={submitting || username.length === 0 || pin.length === 0}>
          {tr('loginSubmit')}
        </button>
      </form>
      {demoUsernames.length > 0 ? (
        <>
          <p className="section-label">{tr('loginDemoAccounts')}</p>
          <div className="chip-row">
            {demoUsernames.map((name) => (
              <button
                type="button"
                key={name}
                className="chip"
                onClick={() => {
                  setUsername(name);
                  setPin('1234');
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}
