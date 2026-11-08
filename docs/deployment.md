# Deployment

## Live URL and demo logins

**https://isocode-swe-assignment.vercel.app** — demo deployment, synthetic data only.

| username | PIN | role | notes |
| --- | --- | --- | --- |
| `demo-officer-1` | `1234` | field officer | links to officer Rahul Chouhan (Indore) |
| `demo-officer-2` | `1234` | field officer | links to officer Neha Solanki (Dewas) |
| `demo-officer-3` | `1234` | field officer | new joiner, no territory — the empty states |
| `demo-manager` | `1234` | branch manager | acts as Indore branch manager Kavita Rathore |

The PIN is a documented demo credential (A31): defined in
`src/server/demo.ts`, hashed at rest with the same scrypt as real users,
and only accepted while the deployment runs `DEMO_MODE=true`. Demo logins
are blocked with the same generic message as any other rejected login.

## Deployment diagram

```
Browser (PWA, offline-first via Dexie/IndexedDB)
   │  HTTPS
   ▼
Vercel (region bom1)                      Neon Postgres (region ap-southeast-1)
├─ static: dist/ (Vite build,             ├─ tables: loan, loan_snapshot,
│  workbox precache, security headers      │  contact_event (append-only trigger),
│  from vercel.json)                       │  promise, payment, score_log, roll_cohort,
├─ rewrite /api/(.*) → /api                │  import_batch(+row_error), officer, territory,
│  └─ api/index.ts → Hono app (serverless) │  assignment_log, audit_log, session,
│     ├─ auth (scrypt + cookie sessions)   │  login_attempt, loan_priority_override
│     ├─ dal (every query actor-scoped)    ├─ pooled connection (@neondatabase/serverless)
│     ├─ nightly job (cron 30 18 * * *)    └─ migrations applied by pnpm db:migrate (never in the build)
│     └─ Vercel cron sends Bearer $CRON_SECRET
```

## Prerequisites

- Node 22.x (`engines` pins it)
- pnpm 12 (`packageManager` pins it; corepack enabled)

## Environment variables

NAMES ONLY — values live in the local `.env` (gitignored) and the Vercel
dashboard, never in the repo. `.env.example` mirrors this table.

| name | purpose | required | secret |
| --- | --- | --- | --- |
| `DATABASE_URL` | pooled Neon connection string for the server and scripts | yes | yes |
| `DATABASE_URL_UNPOOLED` | direct (unpooled) connection for migrations/scripts; falls back to `DATABASE_URL` | no | yes |
| `SESSION_SECRET` | pepper for session-token hashing | yes | yes |
| `DEMO_MODE` | `true`/`1`: demo logins allowed + demo chips served; must NOT be set in a real deployment | yes (demo) | no |
| `MESSAGING_PROVIDER` | mock provider is the only send path (SPEC 14) | no | no |
| `PAYMENT_PROVIDER` | payment feed selector (payments are inferred from the LMS delta, A61) | no | no |
| `LLM_API_KEY` | reserved for the SPEC 8 fitted-model path | no | yes |
| `CRON_SECRET` | bearer token Vercel's cron sends to `POST /api/jobs/nightly`; the endpoint is disabled while unset | no (needed for the cron) | yes |

## Local run

1. `git clone https://github.com/manavmax/isocode_SWE_assignment.git && cd isocode_SWE_assignment`
2. `pnpm install`
3. `cp .env.example .env` and fill at least `DATABASE_URL` (a Neon instance),
   `SESSION_SECRET`, `DEMO_MODE=true`.
4. `pnpm db:migrate` — applies `drizzle/*.sql` in order.
5. `pnpm seed -- --seed 20261105 --as-of 2026-11-07 --yes --reset` — builds
   the 90-day history (78 daily CSVs written to `data/generated/`, then
   imported through the real importer), the promise/contact story, the
   priority scores and the roll cache. ~15 minutes; refuses Sunday as-of
   dates; `--reset` truncates the demo tables first (audited).
6. `pnpm dev` — the app on :5173, API on :8787 (vite proxy).
7. `pnpm test` — the whole suite offline; no database needed.

## Production deploy

1. Neon project in `ap-southeast-1`; copy the pooled connection string.
2. `pnpm db:migrate` against the production database (migrations are never
   part of the build).
3. `pnpm seed …` as above if it is a demo deployment (the production
   deployment of this assignment is a demo — SPEC 14 synthetic data only).
4. Git integration: push to `main`; Vercel builds with `pnpm build`
   (`vite build`), serves `dist/`, region `bom1`, `/api` rewritten to the
   serverless function. No migrations run in the build.
5. Set the environment variables in the Vercel dashboard (production +
   preview): `DATABASE_URL`, `SESSION_SECRET`, `DEMO_MODE`, `CRON_SECRET`
   (plus the optional ones as needed).
6. `vercel deploy --prod` (user-run) — or push and let the Git
   integration build.
7. Verify: `pnpm smoke:live https://<url>` — health, headers, demo
   accounts, logins (officer + manager), promises, scoring, manager
   endpoints, security refusals, logout.

## Migrations, seed, reset, re-base

- `pnpm db:migrate` — apply `drizzle/*.sql` (idempotent; the journal table
  tracks what applied).
- `pnpm db:generate` — regenerate migrations after schema.ts changes
  (drizzle-kit).
- `pnpm seed -- --seed 20261105 --as-of <working day> --yes` — idempotent
  re-run; replays existing files as no-op batches (interrupted runs
  resume exactly this way).
- `pnpm seed -- --seed 20261105 --as-of <working day> --yes --reset` —
  truncate the demo tables (one transaction, audit row first) and rebuild.
- **Re-base demo dates** to a new working day: run the seed with
  `--as-of <today or the last working day>`. The whole story (loan
  history, promise dates, demo worklist) regenerates relative to that
  date. Sunday as-of dates are refused (the importer contract has no
  Sunday file) — pick the previous Saturday.
- The demo story ages under the real clock (in-grace promises flip to
  broken once the real date passes their deadline); a re-base is the
  intended fix before demonstrating.

## Pre-push checklist (local only)

- `pnpm test` — the whole offline suite.
- `pnpm lint && pnpm typecheck` — clean.
- `node scripts/layout-audit.mjs` — 28 screen states, overflow/truncation/
  small-target checks, the float-overlap rules (floating bar and nav pill
  never overlap each other or the last card at 360x640 and 390x844), with
  real device emulation (isMobile + hasTouch, DSF 3).
- `node scripts/design-audit.mjs` — the design-system rules (type scale,
  spacing, contrast, gradients on [data-hero] only, shadows on
  [data-float] only) and the per-screen layout-contract order.
- `node scripts/mobile-check.mjs` — real device emulation (iPhone 13,
  Pixel 7, small Android) for Today, loan detail, outcome sheet,
  promises, me and login: no horizontal scroll, visualViewport scale 1,
  floating chrome >= 8px from the edges and centred within 2px, no
  element wider than the viewport, last card reachable below the
  floating chrome. Screenshots land in docs/screens/mobile/.
- `pnpm smoke:live https://<url>` — after deploying.

## Smoke checklist

`pnpm smoke:live https://isocode-swe-assignment.vercel.app` — 19 checks:
security headers, health, demo accounts, officer login, promises (three
sections), assignments scoring (mode + exactly 3 top reasons), officer
403 on manager endpoints, manager login, dashboard, queue, batches, pin +
unpin round-trip, cross-branch pin 403, officer activity, me, worklist
masking, loan detail, anonymous events 401, logout. Non-zero exit on any
failure; run after every deploy that touches routing or auth.

## Rollback

Roll back the deployment in the Vercel dashboard (Deployments → the last
good build → Promote to Production). The database is forward-only:
migrations are additive and the importer is idempotent — do NOT roll the
schema back; if a bad import landed, re-import the correct file for the
same as-of (same bytes = no-op, different bytes = replace with recompute).

## Free-tier caveats

- Neon wakes from idle: the first request after inactivity can take
  seconds (smoke:live's first check occasionally shows it).
- Vercel serverless cold starts add latency to the first API call.
- Vercel Hobby allows one daily cron (this project uses exactly one).
- Neon connection limits: the pooled driver + the dal's single-query
  pattern keep us inside the free tier.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `POST /api/auth/login` returns Vercel's plain-text 404 (non-JSON) | nested API paths hitting the CDN filesystem before the rewrite (the original single-function routing bug) | keep the vercel.json rewrites `/api/(.*)` → `/api`; check:api covers a nested path for exactly this |
| Seed refuses: "as-of falls on a Sunday" | the importer contract has no Sunday file (skip_sundays: 1) | use the last working day (e.g. the previous Saturday) |
| First request slow after idle | Neon free tier sleeps the compute | warm it with `GET /api/health`; smoke:live tolerates it |
| `403` on manager endpoints as an officer | by design (SPEC 16) | log in as `demo-manager` |
| Login says "wrong username or PIN" unexpectedly | `DEMO_MODE` unset on that deployment blocks demo accounts (A31) | set `DEMO_MODE=true` and redeploy |
| `503 degraded` on everything | `DATABASE_URL` missing/mis-set in the environment | check the dashboard values; `GET /api/health` shows `db: error` |
