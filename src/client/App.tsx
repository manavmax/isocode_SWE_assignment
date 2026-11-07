import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type ApiUser } from './api.js';
import { useLang } from './i18n/LangContext.js';
import { useRoute } from './router.js';
import { startSyncScheduler } from './sync/scheduler.js';
import { resetLoginRequired } from './sync/engine.js';

import { Login } from './screens/Login.js';
import { Today } from './screens/Today.js';

// Route-level code splitting (SPEC 3 budget): the officer's first paint is
// Login + Today; the loan detail (with its sheets and GPS code), the Me
// screen and the Promises screen load on navigation. The manager dashboard,
// when it arrives, follows the same lazy pattern — no manager route exists
// yet, so there is nothing manager-side to split today.
const LoanDetail = lazy(() => import('./screens/LoanDetail.js').then((m) => ({ default: m.LoanDetail })));
const Me = lazy(() => import('./screens/Me.js').then((m) => ({ default: m.Me })));

type Auth = 'checking' | 'signedOut' | 'signedIn';

export function App() {
  const { lang, setLang, t } = useLang();
  const [route, navigate] = useRoute();
  const [auth, setAuth] = useState<Auth>('checking');
  const [user, setUser] = useState<ApiUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    void (async () => {
      const result = await api.me();
      if (result.ok) {
        setUser(result.data.user);
        setAuth('signedIn');
      } else if (result.error.kind === 'network') {
        setAuth('signedIn');
      } else {
        setAuth('signedOut');
      }
    })();
  }, []);

  useEffect(() => {
    const stopSync = startSyncScheduler();
    return () => stopSync();
  }, []);

  // A 401 mid-flush keeps the outbox and asks the officer to log in again
  // (SPEC 6: expired session offline — never wipe). Raised as an event from
  // the engine, handled here as a plain transition, no effect round-trip.
  const handleAuthRequired = useCallback(() => {
    setUser(null);
    setAuth('signedOut');
    setSessionExpired(true);
    navigate({ name: 'login' });
  }, [navigate]);

  useEffect(() => {
    window.addEventListener('fc:auth-required', handleAuthRequired);
    return () => window.removeEventListener('fc:auth-required', handleAuthRequired);
  }, [handleAuthRequired]);

  const isLoginRoute = route.name === 'login';
  const showLogin = auth === 'signedOut' || isLoginRoute;

  function signOut(): void {
    setUser(null);
    setAuth('signedOut');
    navigate({ name: 'login' });
  }

  function signIn(): void {
    void (async () => {
      const result = await api.me();
      if (result.ok) setUser(result.data.user);
      setAuth('signedIn');
      setSessionExpired(false);
      resetLoginRequired();
      navigate({ name: 'today' });
    })();
  }

  if (auth === 'checking' && !isLoginRoute) {
    return (
      <main className="screen">
        <p className="screen-subtitle">{t('stateLoading')}</p>
      </main>
    );
  }

  return (
    <>
      {showLogin ? (
        <Login lang={lang} setLang={setLang} onSignedIn={signIn} sessionExpired={sessionExpired} />
      ) : (
        <>
          <Suspense fallback={<main className="screen"><p className="screen-subtitle">{t('stateLoading')}</p></main>}>
            {route.name === 'loan' ? (
              <LoanDetail lang={lang} loanId={route.loanId} onBack={() => navigate({ name: 'today' })} />
            ) : route.name === 'me' ? (
              <Me lang={lang} setLang={setLang} user={user} onLoggedOut={signOut} />
            ) : (
              <Today lang={lang} onOpenLoan={(loanId) => navigate({ name: 'loan', loanId })} />
            )}
          </Suspense>
          <nav className="bottom-nav" aria-label={t('appName')}>
            <button type="button" className="nav-item" aria-current={route.name === 'today' ? 'page' : undefined} onClick={() => navigate({ name: 'today' })}>
              {t('navToday')}
            </button>
            <button type="button" className="nav-item" aria-current={route.name === 'me' ? 'page' : undefined} onClick={() => navigate({ name: 'me' })}>
              {t('navMe')}
            </button>
          </nav>
        </>
      )}
    </>
  );
}
