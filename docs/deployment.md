# Deployment (demo)

## Environment variables

- `DATABASE_URL` — pooled Neon connection string for the server (Vercel dashboard only, never committed).
- `DATABASE_URL_UNPOOLED` — direct connection for migrations and scripts (`pnpm db:migrate`, `db:generate` fall back to `DATABASE_URL`).
- `DEMO_MODE` — `true` or `1`: demo accounts may log in and demo chips are usable. Must NOT be set in production.

Variables are set in the local `.env` (gitignored) and in the Vercel project dashboard; nothing secrets lives in the repo.

## Order of a deploy (offline-safe steps first)

1. `pnpm install`
2. `pnpm db:migrate` — applies `drizzle/*.sql` (0002 adds the `session` table and `app_user.is_demo`; ADR-0005 AUTH.)
3. `DEMO_MODE=true pnpm demo:accounts` — idempotent creation of the demo logins below (stand-in until the full seed of SPEC §13 exists; the real seed will call the same `ensureDemoAccounts`).
4. `pnpm check:api` — plain-Node ESM load of the Vercel entry, `{ fetch }` shape and degraded `/api/health`.
5. `pnpm build && vercel deploy` (user-run; regions `bom1` via `vercel.json`).

## Demo logins (SPEC 1: demo-account chips)

| username | role | PIN |
| --- | --- | --- |
| `demo-manager` | branch_manager | `1234` |
| `demo-officer-1` | field_officer | `1234` |
| `demo-officer-2` | field_officer | `1234` |

The PIN is a **documented demo credential for the synthetic demo** (assumption A31): defined in the demo seed config (`src/server/demo.ts`), created through `ensureDemoAccounts`, hashed at rest with `node:crypto` scrypt and a per-user salt (same hashing as real users), and never a real secret. Demo accounts can log in **only while the deployment runs with `DEMO_MODE=true`**; the off switch blocks them with the same generic message as any other failed login.

## Auth/session behaviour (ADR-0005)

- Cookie `fc_session`: HttpOnly, Secure, SameSite=Lax, `Path=/`, Max-Age 7 days; the cookie value is a random 32-byte base64url token whose sha256 is the only thing the database stores.
- Sessions expire server-side after 7 days (checked at lookup, so an expired row cannot authenticate even if a cookie survives).
- Login rate limit: 5 failed attempts per username + client IP within 15 minutes (in-memory, per serverless instance — A30), `Retry-After` on 429, counter cleared by a successful login.
- Every auth failure (unknown user, inactive, demo account with the switch off, wrong PIN) answers the same generic `wrong username or PIN`.

## Data-access rules (SPEC 24, A32/A33)

- Routes never open a data connection themselves: every query is a `src/server/dal.ts` function taking the resolved actor; a guard test fails if a route imports a DB driver directly.
- No endpoint returns a full phone number: `9876543321` renders as `98XXXXXX21` (first two digits, X to the remaining length-4, last two). The reveal flow arrives with the contact-window work.
