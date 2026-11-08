# Field Collections

A mobile-first PWA for microfinance field collections officers in the
Malwa region: a daily visit list with an explainable priority score,
offline-first contact logging with a compliance-gated call flow, a
promise tracker with escalation, and a branch manager dashboard with
roll-rate analytics and a daily CSV import — backed by a hard-rolled
Postgres/Drizzle API on Neon.

![Today screen](docs/screens/today-en.png)

**Live**: https://isocode-swe-assignment.vercel.app (demo deployment, synthetic data)

## Demo logins (PIN `1234` — a documented demo credential, hashed at rest, gated by `DEMO_MODE`)

| username | role | what to try |
| --- | --- | --- |
| `demo-officer-1` | field officer (Rahul Chouhan, Indore) | Today list with priority scores and reasons, call flow, offline log-outcome + sync, Promises tab |
| `demo-officer-2` | field officer (Neha Solanki, Dewas) | a different branch's worklist |
| `demo-officer-3` | new joiner (no territory) | the empty states |
| `demo-manager` | branch manager (Indore) | roll-rate dashboard with charts, pin-to-top, import screen, officer activity |

## Quick start (verified — see the fresh-clone note in docs/log.md)

```bash
pnpm install
cp .env.example .env            # fill DATABASE_URL + DEMO_MODE=true (names in the file, values never committed)
pnpm db:migrate                 # applies drizzle/*.sql
pnpm seed -- --seed 20261105 --as-of 2026-11-07 --yes --reset   # ~15 min, 78 daily CSVs through the real importer
pnpm dev                        # app on :5173, API on :8787 (vite proxy)
pnpm test                       # 574 tests, offline (no database needed)
pnpm smoke:live https://isocode-swe-assignment.vercel.app       # after deploying
```

## What maps to the brief

- **SPEC 1/2 (officer app)** — Today list (priority-ordered), loan detail
  with masked phones, outcome sheets, bottom nav, offline states.
- **SPEC 5/6 (offline sync)** — Dexie outbox, single-flight flush with
  backoff, undo hold, duplicate-safe server, 401 keeps the outbox.
- **SPEC 7 (contact window)** — 08:00–19:00 IST gating with skew-corrected
  clocks, BLOCKED attempts recorded, violations stored never discarded.
- **SPEC 8 (AI priority score)** — transparent logistic scorecard, linear
  SHAP reasons in English/Hindi, worklist lanes, back-test
  (docs/backtest.md).
- **SPEC 10 (auto-assignment)** — territory tiers, leave cover, caps,
  hysteresis, assignment log only on change.
- **SPEC 11 (CSV import)** — decode/alias/money/date rules, snapshot
  diffing with aborts, idempotent replays, replace-with-recompute
  (including inferred payments).
- **SPEC 12 (promise tracker)** — creation validation, kept/broken/
  broken_part derivation, nightly recompute, stuck/escalation views.
- **SPEC 13 (manager)** — branch dashboard (roll rates, Wilson intervals,
  migration table, exceptions), manager reorder pins, import screen.
- **SPEC 16 (security/privacy)** — security headers, scrypt+session auth,
  masked phones end-to-end, logout wipe, audit trail (docs/security.md).

## Tests and back-test

- 574 Vitest tests, all offline (fake drivers, fake-indexeddb) — rules are
  named by the SPEC section they enforce.
- `docs/backtest.md`: the scorecard back-tested time-based against the
  seeded 90-day history (AUC 0.613 vs a DPD baseline 0.436; the data is
  synthetic, so this proves the pipeline works, not real-world accuracy).

## Honest limitations

- All data is synthetic (fictional people, A1); scores prove the pipeline,
  not real-world accuracy.
- The scorecard weights are expert priors, not fitted; the documented path
  to a fitted model is the back-test.
- Bounces/vintage reach the scorecard only via the seed's side pass (the
  LMS CSV has no such columns — A65).
- The demo story is anchored to the seed's as-of date and ages; reseed to
  re-base (docs/deployment.md).
- Manager screens are English only (A67); the officer app is bilingual.
- Free-tier reality: Neon wakes from idle (first request can take
  seconds), Vercel functions cold-start.

## 3-minute demo script

**Officer (`demo-officer-1`, PIN 1234)**
1. Today: the worklist is priority-ordered — each card shows the score
   chip (number + band), the top reason in one line.
2. Open a loan: the score panel shows the three reasons with evidence and
   the advisory note; phones are masked.
3. Log an outcome on one loan; the undo toast appears (5 s hold).
4. Airplane mode: log another outcome, open Today again — the offline
   banner shows cached data; the sync pill counts the queued events.
5. Back online: the flush happens automatically (or tap the sync pill);
   open Me → Sync to see the synced items and warnings.

**Manager (`demo-manager`, PIN 1234)**
1. Login lands on the branch dashboard: roll-rate tiles vs the 16% target,
   the trend line, the officer table (greyed under n=30), the migration
   table, the broken/exception lists with **Pin to top**.
2. Pin an exception loan, then open `demo-officer-1`: the loan leads their
   Today list with a "Manager priority" chip.
3. Import: pick `data/sample_overdue.csv`, keep the default as-of, upload —
   the report, assignment outcomes, errors.csv link and past batches are
   all on one screen.
4. Officer activity: last 50 contact events with window flags and GPS.
