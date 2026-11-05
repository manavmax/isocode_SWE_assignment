import { useCallback, useEffect, useState } from 'react';

/** Tiny history-API router, hand-rolled on purpose (SPEC 3: no extra
 * libraries). The app has 4 routes and needs back-button + link support,
 * not nested layouts, loaders or data APIs — react-router (~20 KB gzip) would
 * be an unearned dependency. Replaces: react-router / wouter. */
export type Route =
  | { name: 'login' }
  | { name: 'today' }
  | { name: 'loan'; loanId: string }
  | { name: 'me' };

export function parsePath(path: string): Route {
  const trimmed = path.replace(/\/+$/, '') || '/';
  if (trimmed === '/login') return { name: 'login' };
  if (trimmed === '/today') return { name: 'today' };
  if (trimmed === '/me') return { name: 'me' };
  const loanMatch = /^\/loans\/([^/]+)$/.exec(trimmed);
  if (loanMatch && loanMatch[1]) return { name: 'loan', loanId: decodeURIComponent(loanMatch[1]) };
  return { name: 'today' };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'login':
      return '/login';
    case 'today':
      return '/today';
    case 'me':
      return '/me';
    case 'loan':
      return `/loans/${encodeURIComponent(route.loanId)}`;
  }
}

function currentRoute(): Route {
  return parsePath(window.location.pathname);
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next);
    if (path !== window.location.pathname) {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
