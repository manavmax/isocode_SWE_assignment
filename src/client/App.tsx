import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from 'react';
import { api, type ApiUser } from './api.js';
import { useLang } from './i18n/LangContext.js';
import { useRoute } from './router.js';
import { startSyncScheduler } from './sync/scheduler.js';
import { resetLoginRequired } from './sync/engine.js';
import { useDueTodayCount } from './sync/useDueTodayCount.js';

import { Login } from './screens/Login.js';
import { Today } from './screens/Today.js';

// Route-level code splitting (SPEC 3 budget): the officer's first paint is
// Login + Today; the loan detail (with its sheets and GPS code), the Me
// screen and the Promises screen load on navigation. The manager dashboard,
// when it arrives, follows the same lazy pattern — no manager route exists
// yet, so there is nothing manager-side to split today.
const LoanDetail = lazy(() => import('./screens/LoanDetail.js').then((m) => ({ default: m.LoanDetail })));
// Manager routes are lazy too (prompt 13): the officer bundle never
// downloads the dashboard/import/activity chunks.
const ManagerDashboard = lazy(() => import('./screens/ManagerDashboard.js').then((m) => ({ default: m.ManagerDashboard })));
const ManagerImport = lazy(() => import('./screens/ManagerImport.js').then((m) => ({ default: m.ManagerImport })));
const OfficerActivity = lazy(() => import('./screens/OfficerActivity.js').then((m) => ({ default: m.OfficerActivity })));
const Me = lazy(() => import('./screens/Me.js').then((m) => ({ default: m.Me })));
const Promises = lazy(() => import('./screens/Promises.js').then((m) => ({ default: m.Promises })));

type Auth = 'checking' | 'signedOut' | 'signedIn';

/** 24px line icons (prompt 15): stroke-only, currentColor, no fills. */

function IconToday(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  );
}

function IconPromises(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" />
      <path d="M8 3v4M16 3v4M9 13l2 2 4-4" />
    </svg>
  );
}

function IconDashboard(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

function IconImport(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
    </svg>
  );
}

function IconMe(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 5-5 8-5s6.5 1 8 5" />
    </svg>
  );
}

export function App() {
  const { lang, setLang, t } = useLang();
  const [route, navigate] = useRoute();
  const [auth, setAuth] = useState<Auth>('checking');
  const [user, setUser] = useState<ApiUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const dueToday = useDueTodayCount();

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
      // SPEC 2: a manager lands on their dashboard; officers on Today.
      navigate(result.ok && result.data.user.role === 'branch_manager' ? { name: 'dashboard' } : { name: 'today' });
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
            ) : route.name === 'promises' ? (
              <Promises lang={lang} onOpenLoan={(loanId) => navigate({ name: 'loan', loanId })} />
            ) : route.name === 'dashboard' ? (
              <ManagerDashboard onOpenActivity={(officerId) => navigate({ name: 'activity', officerId })} onOpenImport={() => navigate({ name: 'import' })} onOpenActivityRoute={() => navigate({ name: 'activity', officerId: 'first' })} />
            ) : route.name === 'import' ? (
              <ManagerImport onOpenOverview={() => navigate({ name: 'dashboard' })} onOpenActivityRoute={() => navigate({ name: 'activity', officerId: 'first' })} />
            ) : route.name === 'activity' ? (
              <OfficerActivity officerId={route.officerId} onBack={() => navigate({ name: 'dashboard' })} />
            ) : (
              <Today lang={lang} user={user} onOpenLoan={(loanId) => navigate({ name: 'loan', loanId })} />
            )}
          </Suspense>
          <nav className="bottom-nav" aria-label={t('appName')} data-section="nav" data-float>
            {user?.role === 'branch_manager' ? (
              <>
                <button type="button" className="nav-item" aria-current={route.name === 'dashboard' ? 'page' : undefined} onClick={() => navigate({ name: 'dashboard' })}>
                  <IconDashboard />
                  Dashboard
                </button>
                <button type="button" className="nav-item" aria-current={route.name === 'import' ? 'page' : undefined} onClick={() => navigate({ name: 'import' })}>
                  <IconImport />
                  Import
                </button>
                <button type="button" className="nav-item" aria-current={route.name === 'me' ? 'page' : undefined} onClick={() => navigate({ name: 'me' })}>
                  <IconMe />
                  {t('navMe')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="nav-item" aria-current={route.name === 'today' ? 'page' : undefined} onClick={() => navigate({ name: 'today' })}>
                  <IconToday />
                  {t('navToday')}
                </button>
                <button type="button" className="nav-item nav-item-badge" aria-current={route.name === 'promises' ? 'page' : undefined} onClick={() => navigate({ name: 'promises' })} aria-label={t('navPromises')}>
                  <IconPromises />
                  {t('navPromises')}
                  {dueToday > 0 ? <span className="nav-badge num" aria-hidden="true">{dueToday}</span> : null}
                </button>
                <button type="button" className="nav-item" aria-current={route.name === 'me' ? 'page' : undefined} onClick={() => navigate({ name: 'me' })}>
                  <IconMe />
                  {t('navMe')}
                </button>
              </>
            )}
          </nav>
        </>
      )}
    </>
  );
}
