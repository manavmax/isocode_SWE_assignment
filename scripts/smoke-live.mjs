/**
 * Live smoke check against a DEPLOYED URL (real HTTP, real Vercel routing):
 *   pnpm smoke:live https://<project>.vercel.app
 *
 * In-process checks (pnpm check:api) cannot prove Vercel routing — the CDN
 * filesystem/rewrite layer runs before the function ever sees the request,
 * which is exactly how POST /api/auth/login shipped returning Vercel's own
 * plain-text 404. This script exercises the deployed path end to end and
 * exits non-zero on any failure. Never run it against production data you
 * care about: it logs in as the demo officer and reads their assignments.
 */

const base = process.argv[2];

if (!base || !/^https?:\/\//.test(base)) {
  console.error('usage: pnpm smoke:live <baseUrl>   e.g. pnpm smoke:live https://field-collections.vercel.app');
  process.exit(1);
}
const root = base.replace(/\/+$/, '');

const MASKED = /^\d{2}X+\d{2}$/;
let failures = 0;
let sessionCookie = '';

function report(ok, label, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function call(label, path, init = {}, { auth = true } = {}) {
  const res = await fetch(`${root}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(auth && sessionCookie ? { cookie: sessionCookie } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(20_000)
  });
  const ct = res.headers.get('content-type') ?? '';
  const isJson = ct.includes('application/json');
  let body = null;
  if (isJson) body = await res.json();
  const hint = isJson ? '' : ` (body is not JSON${ct ? `, content-type ${ct}` : ', empty content-type'} — Vercel answered, not our app?)`;
  return { res, body, hint };
}

function maskOk(value) {
  return value === null || MASKED.test(value);
}

// 1. Health: our JSON 200 with db ok (a Vercel plain-text 404 fails here).
{
  const { res, body, hint } = await call('health', '/api/health');
  const ok = res.status === 200 && body?.status === 'ok' && body?.db === 'ok';
  report(ok, 'GET  /api/health', `${res.status}${body ? ` db=${body.db}` : hint}`);
}

// 2. Demo accounts list (public).
{
  const { res, body, hint } = await call('demo-accounts', '/api/demo-accounts');
  const ok = res.status === 200 && Array.isArray(body?.usernames);
  report(ok, 'GET  /api/demo-accounts', `${res.status} usernames=${body?.usernames?.length ?? '?'}${ok ? '' : hint}`);
}

// 3. Login (nested path — the route that shipped broken): 200 + cookie.
{
  const { res, body, hint } = await call('login', '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'demo-officer-1', pin: '1234' })
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const ok = res.status === 200 && cookie.startsWith('fc_session=') && body?.user?.username === 'demo-officer-1';
  if (res.status === 401) {
    report(false, 'POST /api/auth/login', '401 — demo login refused; is DEMO_MODE=true set on this deployment?');
  } else {
    report(ok, 'POST /api/auth/login', `${res.status}${cookie ? ' cookie set' : ' NO cookie'}${ok ? '' : hint}`);
  }
  sessionCookie = cookie;
}

// Everything below needs the session cookie.
if (sessionCookie.startsWith('fc_session=')) {
  // 4. Me (nested under /api, two segments deep).
  {
    const { res, body, hint } = await call('me', '/api/me');
    const ok = res.status === 200 && body?.user?.username === 'demo-officer-1';
    report(ok, 'GET  /api/me', `${res.status}${ok ? ` role=${body.user.role}` : hint}`);
  }

  // 5. Assignments: nested three segments deep; phones must be masked AND the
  // demo officer's worklist must be non-empty — in a demo deployment an empty
  // worklist is a failure, not a state to skip over.
  let loanId = null;
  {
    const { res, body, hint } = await call('assignments', '/api/me/assignments');
    const assignments = body?.assignments;
    const phonesMasked = Array.isArray(assignments) && assignments.every((a) => maskOk(a.mobileMasked));
    loanId = Array.isArray(assignments) ? (assignments.find((a) => a.loanId)?.loanId ?? null) : null;
    const ok = res.status === 200 && Array.isArray(assignments) && assignments.length > 0 && phonesMasked;
    report(ok, 'GET  /api/me/assignments', `${res.status} count=${assignments?.length ?? '?'} phones masked=${phonesMasked}${ok ? '' : hint}`);
    if (res.status === 200 && Array.isArray(assignments) && assignments.length === 0) {
      report(false, 'GET  /api/me/assignments (worklist)', 'demo officer has no assigned loans: seed missing, demo account not linked to an officer, or the deployment points at a different database');
    }
  }

  // 6. Loan detail from the assignment list (its precondition is asserted
  // above: an empty worklist already failed the run there).
  if (loanId) {
    const { res, body, hint } = await call('loan', `/api/loans/${encodeURIComponent(loanId)}`);
    const ok = res.status === 200 && body?.loan?.loanId === loanId && maskOk(body.loan.mobileMasked) && maskOk(body.loan.altMobileMasked);
    report(ok, `GET  /api/loans/${loanId}`, `${res.status}${ok ? '' : hint}`);
  }
} else {
  report(false, 'GET  /api/me + /api/me/assignments + /api/loans/<id>', 'skipped — no session cookie from login');
}

// 7. Events batch without a cookie must be 401 (our JSON, not a router 404).
{
  const { res, body, hint } = await call('events-anon', '/api/events/batch', {
    method: 'POST',
    body: JSON.stringify({ events: [] })
  }, { auth: false });
  const ok = res.status === 401 && body?.error === 'unauthorized';
  report(ok, 'POST /api/events/batch (no cookie)', `${res.status} ${body?.error ?? hint}`);
}

// 8. Logout with the session cookie.
if (sessionCookie.startsWith('fc_session=')) {
  const { res, body, hint } = await call('logout', '/api/auth/logout', { method: 'POST' });
  const ok = res.status === 200 && body?.ok === true;
  report(ok, 'POST /api/auth/logout', `${res.status}${ok ? '' : hint}`);
} else {
  report(false, 'POST /api/auth/logout', 'skipped — no session cookie from login');
}

if (failures > 0) {
  console.error(`smoke:live FAILED: ${failures} check(s) failed against ${root}`);
  process.exit(1);
}
console.log(`smoke:live OK — all checks passed against ${root}`);
