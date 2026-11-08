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

// 0. Security headers (prompt 14a item 7): every check below reads the
// health response's headers — the app and the API must both carry them.
{
  const { res, hint } = await call('headers', '/api/health');
  const h = (name) => res.headers.get(name) ?? '';
  const headerOk =
    h('strict-transport-security').includes('max-age=31536000') &&
    h('x-content-type-options') === 'nosniff' &&
    (h('x-frame-options') === 'DENY' || h('content-security-policy').includes("frame-ancestors 'none'")) &&
    h('referrer-policy') === 'strict-origin-when-cross-origin' &&
    h('content-security-policy').includes("frame-ancestors 'none'") &&
    h('content-security-policy').includes("default-src 'self'");
  report(headerOk, 'Security headers on /api/health', `hsts=${Boolean(h('strict-transport-security'))} nosniff=${h('x-content-type-options') === 'nosniff'} frame-ancestors=${h('content-security-policy').includes("frame-ancestors 'none'")} referrer=${h('referrer-policy') || 'MISSING'}${headerOk ? '' : ` hint(${res.status})`}`);
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

// 6b. Officer-scoped reads that must work for an officer: promises with the
// three sections, and the assignments response carrying the scorecard mode
// with exactly three top reasons on the first loan (SPEC 8/12 checks the
// user pinned to smoke:live).
let managerCookie = '';
if (sessionCookie.startsWith('fc_session=')) {
  const promisesRes = await call('promises', '/api/me/promises');
  const p = promisesRes.body;
  const promisesOk =
    promisesRes.res.status === 200 &&
    Array.isArray(p?.dueToday) &&
    Array.isArray(p?.upcoming) &&
    Array.isArray(p?.brokenNeedingFollowup);
  report(promisesOk, 'GET  /api/me/promises', `${promisesRes.res.status} due=${p?.dueToday?.length ?? '?'} upcoming=${p?.upcoming?.length ?? '?'} broken=${p?.brokenNeedingFollowup?.length ?? '?'}`);

  const scoredRes = await call('assignments-scored', '/api/me/assignments');
  const s = scoredRes.body;
  const first = s?.assignments?.[0];
  const scoringOk =
    scoredRes.res.status === 200 &&
    (s?.scoringMode === 'scorecard' || s?.scoringMode === 'fallback') &&
    first?.score !== null &&
    Array.isArray(first?.topReasons) &&
    first.topReasons.length === 3;
  report(
    scoringOk,
    'GET  /api/me/assignments (scoring)',
    `${scoredRes.res.status} mode=${s?.scoringMode ?? '?'} first score=${first?.score ?? '?'} reasons=${first?.topReasons?.length ?? 0}`
  );

  // 7. Officers are refused on every manager endpoint (403, no db work).
  const officerForbidden = await call('manager-as-officer', '/api/manager/dashboard');
  report(officerForbidden.res.status === 403, 'GET  /api/manager/dashboard (as officer) — 403', `${officerForbidden.res.status} ${officerForbidden.body?.error ?? ''}`);

  // Manager login: a second session for the manager endpoints.
  const managerLogin = await call('manager-login', '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'demo-manager', pin: '1234' })
  });
  managerCookie = (managerLogin.res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  report(
    managerLogin.res.status === 200 && managerCookie.startsWith('fc_session=') && managerLogin.body?.user?.role === 'branch_manager',
    'POST /api/auth/login (demo-manager)',
    `${managerLogin.res.status} role=${managerLogin.body?.user?.role ?? '?'}${managerCookie ? ' cookie set' : ' NO cookie'}`
  );
} else {
  report(false, 'GET /api/me/promises + manager login', 'skipped — no officer session');
}

// Manager endpoints (SPEC 13): dashboard, queue, import batches, pin +
// unpin round-trip, officer activity. All manager-only (demo-manager).
if (managerCookie.startsWith('fc_session=')) {
  const prevCookie = sessionCookie;
  sessionCookie = managerCookie;

  const dash = await call('manager-dashboard', '/api/manager/dashboard');
  const d = dash.body;
  const dashOk =
    dash.res.status === 200 &&
    typeof d?.branchName === 'string' &&
    typeof d?.queueCount === 'number' &&
    Array.isArray(d?.officerTable) &&
    Array.isArray(d?.exceptions) &&
    Array.isArray(d?.brokenPromises);
  report(dashOk, 'GET  /api/manager/dashboard', `${dash.res.status} branch=${d?.branchName ?? '?'} windows=${d?.trendWindowsAvailable ?? '?'} officers=${d?.officerTable?.length ?? '?'}${dashOk ? '' : ''}`);

  const queueRes = await call('manager-queue', '/api/manager/queue');
  report(queueRes.res.status === 200 && Array.isArray(queueRes.body?.queue), 'GET  /api/manager/queue', `${queueRes.res.status} queued=${queueRes.body?.queue?.length ?? '?'}`);

  const batchesRes = await call('manager-batches', '/api/manager/import-batches');
  report(batchesRes.res.status === 200 && Array.isArray(batchesRes.body?.batches), 'GET  /api/manager/import-batches', `${batchesRes.res.status} batches=${batchesRes.body?.batches?.length ?? '?'}`);

  const exception = d?.exceptions?.[0];
  const broken = d?.brokenPromises?.[0];
  const pinTarget = exception ?? broken;
  if (pinTarget && (exception ? d.officerTable.some((o) => o.officerName === (exception.officerName ?? '')) : d.officerTable.some((o) => o.officerName === (broken.officerName ?? '')))) {
    const officerId = d.officerTable.find((o) => o.officerName === pinTarget.officerName)?.officerId;
    const pinRes = await call('manager-pin', '/api/manager/priority', {
      method: 'POST',
      body: JSON.stringify({ loanId: pinTarget.loanId, officerId })
    });
    report(pinRes.res.status === 200 && pinRes.body?.ok === true, 'POST /api/manager/priority (pin exception loan)', `${pinRes.res.status} loan=${pinTarget.loanId}`);
    const unpinRes = await call('manager-unpin', `/api/manager/priority/${encodeURIComponent(pinTarget.loanId)}`, { method: 'DELETE' });
    report(unpinRes.res.status === 200 && unpinRes.body?.ok === true, `DELETE /api/manager/priority/${pinTarget.loanId}`, `${unpinRes.res.status}`);
  } else {
    report(false, 'POST /api/manager/priority', 'no exception/broken row with an officer to pin — seed the demo story');
  }

  const officerId = d?.officerTable?.[0]?.officerId;
  if (officerId) {
    const activity = await call('manager-activity', `/api/manager/officers/${officerId}/activity`);
    report(activity.res.status === 200 && Array.isArray(activity.body?.activity), 'GET  /api/manager/officers/:id/activity', `${activity.res.status} events=${activity.body?.activity?.length ?? '?'}`);
  }

  // A manager cannot pin or read another branch's data: pin to a loan the
  // manager's branch does not own must answer 403.
  const crossPin = await call('manager-pin-cross', '/api/manager/priority', {
    method: 'POST',
    body: JSON.stringify({ loanId: 'LN-99999999', officerId: d?.officerTable?.[0]?.officerId })
  });
  report(crossPin.res.status === 403, 'POST /api/manager/priority (foreign loan) — 403', `${crossPin.res.status}`);

  sessionCookie = prevCookie;
} else {
  report(false, 'Manager endpoints', 'skipped — no manager session');
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
  // demo officer's worklist must carry a real demo (step 0.5: demo-officer-1
  // links to Rahul Chouhan — at least 10 assigned overdue loans; a thin
  // worklist is a failure, not a state to skip over).
  const DEMO_WORKLIST_MIN = 10;
  let loanId = null;
  {
    const { res, body, hint } = await call('assignments', '/api/me/assignments');
    const assignments = body?.assignments;
    const phonesMasked = Array.isArray(assignments) && assignments.every((a) => maskOk(a.mobileMasked));
    loanId = Array.isArray(assignments) ? (assignments.find((a) => a.loanId)?.loanId ?? null) : null;
    const ok = res.status === 200 && Array.isArray(assignments) && assignments.length >= DEMO_WORKLIST_MIN && phonesMasked;
    report(ok, 'GET  /api/me/assignments', `${res.status} count=${assignments?.length ?? '?'} (min ${DEMO_WORKLIST_MIN}) phones masked=${phonesMasked}${ok ? '' : hint}`);
    if (res.status === 200 && Array.isArray(assignments) && assignments.length < DEMO_WORKLIST_MIN) {
      report(false, 'GET  /api/me/assignments (demo worklist)', `demo-officer-1 must hold at least ${DEMO_WORKLIST_MIN} assigned overdue loans: seed missing/outdated, demo account not linked to its staff officer, or the deployment points at a different database`);
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
