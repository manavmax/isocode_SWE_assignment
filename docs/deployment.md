# Deployment (demo)

## Environment variables

- `DATABASE_URL` — pooled Neon connection string for the server (Vercel dashboard only, never committed).
- `DATABASE_URL_UNPOOLED` — direct connection for migrations and scripts (`pnpm db:migrate`, `db:generate` fall back to `DATABASE_URL`).
- `DEMO_MODE` — `true` or `1`: demo accounts may log in and demo chips are usable. Must NOT be set in production.

Variables are set in the local `.env` (gitignored) and in the Vercel project dashboard; nothing secrets lives in the repo.

## Order of a deploy (offline-safe steps first)

1. `pnpm install`
2. `pnpm db:migrate` — applies `drizzle/*.sql` (0002 adds the `session` table and `app_user.is_demo`; 0003 adds the `login_attempt` throttle table; ADR-0005 auth).
3. `DEMO_MODE=true pnpm demo:accounts` — idempotent re-link of the demo logins below. The full seed (SPEC §13) calls the same `ensureDemoAccounts` itself; the standalone command only re-runs that step and REQUIRES the seeded staff to exist (the chips link to real officer/manager rows), so it fails with a clear message on a fresh database — run the seed first.
4. `pnpm check:api` — plain-Node ESM load of the Vercel entry, `{ fetch }` shape and degraded `/api/health`.
5. `pnpm build && vercel deploy` (user-run; regions `bom1` via `vercel.json`).

## Demo logins (SPEC 1: demo-account chips)

| username | role | PIN | acts as |
| --- | --- | --- | --- |
| `demo-manager` | branch_manager | `1234` | Kavita Rathore, the Indore branch manager (branch queue view) |
| `demo-officer-1` | field_officer | `1234` | Rahul Chouhan (Indore; >= 10 assigned overdue loans) |
| `demo-officer-2` | field_officer | `1234` | Neha Solanki (Dewas; >= 10 assigned overdue loans) |
| `demo-officer-3` | field_officer | `1234` | a new-joiner officer with no territory — the empty-worklist state |

The chips do not own officers of their own: each links to seeded staff, resolved from the database at seed time (step 0.5, assumption A60) — so the demo shows real, seeded worklists. The PIN is a **documented demo credential for the synthetic demo** (assumption A31): defined in the demo seed config (`src/server/demo.ts`), created through `ensureDemoAccounts`, hashed at rest with `node:crypto` scrypt and a per-user salt (same hashing as real users), and never a real secret. Demo accounts can log in **only while the deployment runs with `DEMO_MODE=true`**; the off switch blocks them with the same generic message as any other failed login.

## Auth/session behaviour (ADR-0005)

- Cookie `fc_session`: HttpOnly, Secure, SameSite=Lax, `Path=/`, Max-Age 7 days; the cookie value is a random 32-byte base64url token whose sha256 is the only thing the database stores.
- Sessions expire server-side after 7 days (checked at lookup, so an expired row cannot authenticate even if a cookie survives).
- Login rate limit: 5 failed attempts per username + client IP within 15 minutes; the counter lives in the `login_attempt` table (`key`, `fail_count`, `window_start`), so it holds across serverless instances and invocation boundaries (A30, migration 0003). `Retry-After` on 429; a successful login deletes the row.
- Cookie sessions are the only accepted API auth: `/api/import` and `errors.csv` resolve the `fc_session` cookie alone. The Basic header path (import-check scaffolding) was removed outright rather than NODE_ENV-gated — one mechanism, one attack surface; local scripts authenticate through `POST /api/auth/login` like the UI does.
- Every auth failure (unknown user, inactive, demo account with the switch off, wrong PIN) answers the same generic `wrong username or PIN`.

## Data-access rules (SPEC 24, A32/A33)

- Routes never open a data connection themselves: every query is a `src/server/dal.ts` function taking the resolved actor; a guard test fails if a route imports a DB driver directly.
- No endpoint returns a full phone number: `9876543321` renders as `98XXXXXX21` (first two digits, X to the remaining length-4, last two). The reveal flow arrives with the contact-window work.
