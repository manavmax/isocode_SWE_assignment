# Security (SPEC 16)

Prompt 14a's pass: headers, the endpoint/access-control table, audit
coverage, secrets, dependency audit, and privacy guarantees. The
executable form of the access-control matrix is
`src/server/accessControl.test.ts` (endpoint × role → expected status);
manager-route refusals are additionally covered in
`src/server/managerSecurity.test.ts`, and every role check is re-proven
against the live deployment by `scripts/smoke-live.mjs`.

## Security headers

Set in BOTH `vercel.json` (static app) and a Hono middleware (`/api/*`) so
the layers cannot drift:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  (self-hosted fonts — SPEC 15; `style-src 'unsafe-inline'` is required by
  React's inline style props; everything else is same-origin)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(self), camera=(), microphone=()` (GPS
  is a core feature; camera/microphone never)

Verified by `scripts/smoke-live.mjs` on every run and by `curl -I` on the
live URL (see the prompt-14a log entry for the captured output).

## Endpoint table

| Endpoint | Methods | Roles | Body/query schema | Rate limit | Audit |
| --- | --- | --- | --- | --- | --- |
| `/api/health` | GET | public | — | — | — |
| `/api/demo-accounts` | GET | public (usernames only; `[]` unless `DEMO_MODE`) | — | — | — |
| `/api/auth/login` | POST | public | `loginRequestSchema` (username, PIN digits) | 5 failures / 15 min per username+IP (login_attempt table, A30) | `auth:login` on success; failures in `login_attempt` + runtime logs |
| `/api/auth/logout` | POST | any session | — | — | — |
| `/api/me` | GET | officer, manager | — | — | — |
| `/api/me/assignments` | GET | officer (403 manager) | — | — | — |
| `/api/me/promises` | GET | officer (403 manager) | — | — | — |
| `/api/loans/:id` | GET | assigned officer; same-branch manager; else generic 404 (A33) | — | — | — |
| `/api/loans/:id/reveal-phone` | POST | assigned officer, in-window | loan id param | 30 reveals / officer / hour (A56, login_attempt table) | every allowed reveal (no phone in the row) |
| `/api/events/batch` | POST | officer | `contactEventBatchSchema` (≤ 20 events) | — | per-event contact_event is the record; mismatches audited |
| `/api/import` | POST | manager (any branch, A19) | multipart CSV + `as_of` (validated) | — | `import:apply` / `import:abort` |
| `/api/import/:id/errors.csv` | GET | manager (any branch) | batch id | — | `import:errors_download` |
| `/api/manager/dashboard` | GET | manager | — | — | — |
| `/api/manager/officers/:id/activity` | GET | manager (own-branch officer; foreign answers empty) | officer id param | — | — |
| `/api/manager/priority` | POST | manager (loan AND officer in own branch, checked in the dal) | `{ loanId, officerId }` | — | `priority:pin` |
| `/api/manager/priority/:loanId` | DELETE | manager (own-branch pin only) | loan id param | — | `priority:unpin` |
| `/api/manager/queue` | GET | manager | — | — | — |
| `/api/manager/import-batches` | GET | manager | — | — | — |
| `/api/jobs/nightly` | POST | cron only (`Authorization: Bearer $CRON_SECRET`, constant-time compare; disabled while unset) | — | — | — |

Every cookie session is HttpOnly Secure SameSite=Lax carrying only a
random token whose SHA-256 is stored (A30); password/PIN hashes are
scrypt with per-user salts.

## Access-control matrix

`src/server/accessControl.test.ts` asserts exactly this (statuses through
the real routes):

| Endpoint | Anonymous | Officer (own branch) | Officer (other branch) | Manager (own branch) | Manager (other branch) |
| --- | --- | --- | --- | --- | --- |
| `GET /api/health` | 200 | 200 | 200 | 200 | 200 |
| `POST /api/auth/login` | 401 on bad creds | 401 / 200 | 401 / 200 | 401 / 200 | 401 / 200 |
| `GET /api/demo-accounts` | 200 (gated) | 200 (gated) | 200 (gated) | 200 (gated) | 200 (gated) |
| `GET /api/me` | 401 | 200 | 200 | 200 | 200 |
| `GET /api/me/assignments` | 401 | 200 | 200 | 403 | 403 |
| `GET /api/me/promises` | 401 | 200 | 200 | 403 | 403 |
| `GET /api/loans/:id` | 401 | 200 assigned / 404 not assigned | 404 | 200 own branch | 404 |
| `POST /api/events/batch` | 401 | 200/400 (auth passes) | 200/400 | — (manager not offered) | — |
| `POST /api/import` | 401 | 403 | 403 | 200/4xx (auth passes) | 200/4xx |
| `GET /api/import/:id/errors.csv` | 401 | 403 | 403 | 200/404 | 200/404 |
| `GET /api/manager/*` | 401 | 403 | 403 | 200/4xx | 403/404 (branch-scoped) |
| `POST /api/manager/priority` | 401 | 403 | 403 | 200 own branch / 403 foreign | 403/404 |
| `POST /api/jobs/nightly` | 401 | 401 | 401 | 401 (no bearer) | 401 (no bearer) |

"Other-branch manager" is refused by the branch predicate inside every
manager query and by the pin/unpin dal checks — not by a separate route
list, so a new manager endpoint cannot forget it.

## Audit coverage (SPEC 16)

`audit_log` rows (append-only usage; the table has no delete path in code):

- `auth:login` — every successful login (actor, user id, role).
- `import:apply` / `import:abort` — every import outcome with its report.
- `import:errors_download` — every errors.csv download (batch, row count).
- `reveal-phone` — every allowed reveal (never the phone itself).
- `priority:pin` / `priority:unpin` — manager reorder, with who pinned.
- `import:gone` — per-loan clearances from a full-file import.
- `assignment:failed` / `promise_nightly:failed` / `scoring:failed` —
  background failures, never fatal to the caller.
- `import:reset` (A17) — the demo reset writes its audit row FIRST.
- Failed logins are captured durably in the `login_attempt` table (key,
  fail_count, window — A30) plus structured runtime logs; a deliberate
  choice to keep failure noise out of audit_log while keeping it
  queryable.

## Secrets

- `gitleaks` runs as a pre-commit hook over every commit (staged content);
  the full history was scanned for this pass — clean (see the log entry).
- `.env.example` carries NAMES only; `.env` is gitignored (`.env`,
  `.env.local`, `.env.*.local`), as are `data/generated/` (seed CSVs) and
  jar logs.
- The demo PIN (`1234`) is a documented demo credential (A31,
  docs/deployment.md) — it appears in source only as the `DEMO_PIN`
  constant in `src/server/demo.ts`, is hashed at rest with the same scrypt
  as real users, and only logs in while `DEMO_MODE=true`. It is not a
  secret.
- `DATABASE_URL` / `SESSION_SECRET` / `CRON_SECRET` exist only in `.env`
  and the Vercel dashboard; never committed.

## Dependencies

`pnpm audit` was run for this pass (see the log entry for the exact
output). Findings were either fixed in the same commit or recorded below
with the reason for deferring.

## Privacy (SPEC 16)

- Logout wipes every offline table: `clearCache()` (src/client/dexie/db.ts)
  clears the outbox, meta (skew/last-sync), the reveal cache, the
  assignment cache and the promise cache; `Me → Log out` calls it
  (tested in `src/client/dexie/db.test.ts`).
- The assignment/promise caches expire after 24 h (`CACHE_TTL_MS`,
  tested) and the reveal cache expires at the end of the IST day
  (tested).
- No list response carries a full phone number: masking happens inside the
  dal (`maskPhone`), asserted in `src/server/dataAccess.test.ts`
  (`JSON.stringify(body)` must not contain the raw number) and proven
  live by smoke:live's masked-phones check. The only unmasked payload is
  the in-window reveal-phone response, which is audited and rate-limited.
