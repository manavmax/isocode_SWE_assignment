# SPEC: Field Collections App (MSME lender, Indore)

Read this file at the start of every session. It is the source of truth for scope, rules and conventions.
If a request conflicts with this file, say so before acting.

## 1. What we are building

A mobile-first PWA for an RBI-registered NBFC's collections team (client "Company A", Indore).
Field officers get a prioritised daily visit list with reasons. Branch managers get roll rates, broken promises and an import screen.
This is a 7-day solo take-home. Core build must work end to end on realistic seeded data. No dead buttons.

Users and roles:
- `field_officer`: sees only their own assigned loans. Phone, one-handed, weak signal, Hindi or English.
- `branch_manager`: sees their branch. Imports the daily CSV, reorders lists, sees the dashboard.

Out of scope (do not build): cash receipts and payment links (mock only), legal notices, auto-dialler or voice bot, real SMS or WhatsApp sending, real payments.

## 2. Core screens (6 to 8 plus 3 sheets)

1. Login (language toggle हिंदी / English, username + PIN, demo-account chips)
2. Officer: Today (priority list)
3. Officer: Loan detail (facts, top-3 reasons, sticky bar: Call, Map, Log outcome)
4. Officer: Promises (Due today, Upcoming, Broken)
5. Officer: Sync / Me (pending, failed, synced; Sync now; logout)
6. Manager: Dashboard (roll rate by branch/officer, broken promises, blocked attempts)
7. Manager: Import and Assignment (upload CSV, report, unmapped pincodes, over-cap officers)
Sheets: Outcome sheet, Reminder preview, Blocked-by-window notice.

Every screen has deliberate loading (skeleton), empty, error and offline states, each with one primary action.

## 3. Stack (decided)

- React + TypeScript on Vite, `vite-plugin-pwa` (Workbox only to precache the shell)
- Dexie (IndexedDB) with a hand-rolled outbox. No sync engine.
- Hono API, Drizzle ORM, Neon Postgres, Zod for all request validation
- Vitest (unit), `fake-indexeddb`, Playwright (one e2e path, against a production build)
- Deploy: Vercel (static + one serverless API function) + Neon. Region: India or nearest; state it as an assumption.
- Single repo, one language, pnpm. Node 20.19+ or 22.12+.
- Avoid extra libraries: no i18n framework (use a typed dictionary), no chart library (hand-rolled SVG), no component kit (use native `<dialog>`).
- Pin versions after `npm view <pkg> version time.modified`. Do not use vite-plugin-pwa 2.x unless tested.
- Fallback if the Vercel + Hono deploy spike fails: Next.js route handlers.

Auth: timebox 45 minutes to try Better Auth with username + password. If it does not work cleanly, use DB sessions, `node:crypto` scrypt, HttpOnly Secure SameSite=Lax cookie.

## 4. Architecture rules

- Business rules are pure TypeScript functions in `src/shared` with no I/O: contact window, scoring, assignment, roll rate, promise state, word filter, formatters. Everything testable without a database.
- The officer UI reads and writes only IndexedDB. A `sync` module pulls assignments into Dexie and pushes the outbox.
- The server owns truth: validates, deduplicates on event id, stamps `synced_at`, re-evaluates compliance, derives promise state and roll rates.
- One data-access layer. Every query takes an `actor` (user + role + branch/officer). No route touches the DB directly.
- Mock providers behind interfaces: `MessageProvider`, `PaymentProvider`, each with a `Fake` implementation.
- All money is integer paise. All instants are UTC; IST is derived. Contact event ids are client-generated UUIDs.

## 5. Data model (minimum)

| Table | Key fields |
|---|---|
| branch | id, code, name |
| app_user | id, username, password_hash, role, branch_id, officer_id?, active |
| officer | id, branch_id, name, active, capacity_points, buddy_officer_id |
| officer_absence | officer_id, from_date, to_date, cover_officer_id |
| territory | branch_id, pincode, locality?, officer_id, rank (locality row beats pincode row) |
| loan | loan_id (natural key), borrower_name, business_name, mobile, alt_mobile, address, pincode, locality, branch_id, product, outstanding, overdue_amount, emi_amount, dpd, bucket, assigned_officer_id, home_officer_id, entered_overdue_on, status (overdue/cleared/queue), bounce_count_12m, vintage_months, is_demo |
| loan_snapshot | as_of, loan_id, branch_id, officer_id, dpd, bucket, outstanding. Unique (as_of, loan_id) |
| import_batch | id, as_of, file_sha256, filename, status, row_counts_json, created_by. Unique (as_of, file_sha256) |
| import_row_error | batch_id, row_no, loan_id, column, code, severity, raw_value, message |
| assignment_log | loan_id, run_date, from_officer, to_officer, reason. Written only on change |
| contact_event (append-only) | id UUID PK, loan_id, officer_id, kind (CALL/VISIT/MESSAGE/BLOCKED), outcome, attempted_at_device, device_tz_offset_min, skew_estimate_ms, synced_at, attempted_at_ist, within_window, time_confidence, rule_set, lat, lng, accuracy_m, gps_status, note, corrects_event_id, compliance_status |
| promise | id, loan_id, officer_id, source_event_id, created_at, promised_amount, promised_date, grace_days, status, resolved_at, paid_amount, superseded_by |
| payment | id, loan_id, amount, posted_at, source (mock/lms_delta) |
| message_outbox | id, loan_id, template_id, language, status, scheduled_for, provider_ref |
| score_log (immutable) | loan_id, as_of, p_roll, score, rank, reasons_json, features_json, model_version |
| roll_cohort | t0, t1, branch_id, officer_id, cohort_n, cured_n, stayed_n, rolled_n, cohort_amt, rolled_amt |
| audit_log | id, actor, action, subject, at, detail |

`contact_event` has no update or delete. A correction is a new event with `corrects_event_id`.

## 6. Offline sync (hard part #1)

Client:
1. Officer taps an outcome. App generates `crypto.randomUUID()`, writes to Dexie `outbox` (state `pending`) before any network call, shows "Saved on phone, will sync".
2. Single-flight `flush()` sends oldest-first batches of 20 to `POST /api/events/batch`, 15 s `AbortSignal.timeout`.
3. Triggers: app start, `online` event, visibility change, after each save, every 30 to 60 s while visible with pending items, manual "Sync now". Do not gate on `navigator.onLine`.
4. Retry network errors, timeouts, 429, 5xx with exponential backoff and jitter (2 s doubling, 5 min cap, reset on online or foreground). Mark 4xx validation failures `failed` with visible Retry/Discard. Never retry 4xx blindly.
5. `created` and `duplicate` both count as success. Never delete a local event before one of those.

Server:
- `INSERT ... ON CONFLICT (id) DO NOTHING` per item. Return HTTP 200 with `[{id, status: created|duplicate|rejected, reason}]` so one bad item cannot block the queue.
- Same id with a different payload: keep the first, log the mismatch, return `duplicate`.
- Never accept a client-supplied `synced_at`.
- Loan reassigned while officer was offline: accept the event, flag `assignment_changed`.
- Expired session offline: keep the outbox, prompt re-login, never wipe it.

Conflict rule (one sentence): events are append-only and never conflict; anything editable is a new event that supersedes the old one; where a field must be edited in place, server wins with a visible notice.

Platform limits to state in the TDD: iOS Safari has no Background Sync (through 27.2); Periodic Background Sync is Chrome/Edge only; Safari tabs lose storage after 7 days without interaction (Home Screen apps exempt). So: in-page flush is primary, a manual Sync button, a prominent unsynced count, call `navigator.storage.persist()` and warn if false with pending items, guidance to install to Home Screen. Background Sync registration is optional.

Required tests: duplicate id returns `duplicate`; crash after server accepted but before client marked synced (resend gives one row); 4xx not retried; single-flight under concurrent flushes; oldest first; partial batch failure; backoff schedule; expired session keeps outbox.

## 7. Contact window (hard part #2)

- Window is 08:00 to 19:00 Asia/Kolkata, evaluated on the attempt instant, never on sync time. `istMinutes = (utcMs/60000 + 330) mod 1440`; allowed if `480 <= istMinutes < 1140`. No dependence on device timezone.
- Block on call start; warn if a logged call ran past 19:00. Label this an assumption.
- Three layers: (a) UI gate disables Call/WhatsApp/SMS outside the window with a bilingual reason, and reveals the unmasked phone only inside the window; (b) server gate re-derives `within_window` from device time and skew-corrected time on sync and sets `compliance_status = VIOLATION_DETECTED`; (c) send gate: the mock provider refuses to deliver outside the window and the outbox holds until 08:00 IST.
- Blocked attempts are `BLOCKED` events carrying rule code and rule-set version, with no raw text. Manager dashboard shows the count.
- Logging an outcome stays possible outside the window (a 19:40 visit must be recordable); it is marked as a violation, not lost.
- Clock skew: each sync response returns `serverNow`; client stores skew = `serverNow - (t_sent + t_received)/2` and stamps events. `time_confidence`: high (fresh sync, skew < 5 min), low (stale/unknown), suspect (Date.now deltas disagree with performance.now deltas). Flag, never silently reject.
- Rule sets are versioned config: `RBC2025_para100` and `RECOVERY2026_100Y`, selected by attempt date. Both use 08:00 to 19:00. 2027 changes (effective 1 Jan 2027) are built as a declared assumption: hard window with `borrower_requested_time` exception needing an evidence field, template-only outbound messages, grievance-officer footer on every message, call metadata fields (logging only), internal attempt cap of 3 calls and 1 visit per loan per day (labelled internal policy, not RBI).
- GPS only at discrete events (outcome save). Warm up with `watchPosition`, keep best fix, accept `accuracy <= 100 m`, else store with `low_accuracy`. Never block saving on GPS. Status enum: ok, low_accuracy, denied, unavailable, timeout, not_requested. Never fabricate coordinates.

Required tests: 07:59:59, 08:00:00, 18:59:59, 19:00:00 IST; UTC instants on a different IST date; device in another timezone; borrower-requested exception with/without evidence; call started 18:59 ended 19:03; rule-set switch at 2027-01-01.

## 8. AI: priority score (advisory, explainable)

Transparent logistic scorecard centred on the brief's 22% roll rate. Do not call it machine learning. Describe it as a scorecard with a documented path to a fitted model.

- `z_j = clip((x_j - mu_j)/sd_j, -3, 3)`, `log1p` on amounts and days-since-contact.
- `logit(p_roll) = b0 + sum(beta_j * z_j)`, `b0 = logit(0.22) = -1.27`, `score = round(100 * p_roll)`.
- Bands: High >= 40, Medium 20 to 39, Low < 20.
- Promise-kept rate shrunk: `(kept+2)/(made+3)`.

| Feature | Beta |
|---|---|
| DPD | +0.55 |
| Bounces last 6 months (cap 4) | +0.40 |
| Broken promises last 90 days (cap 3) | +0.45 |
| Promise-kept rate (shrunk) | -0.40 |
| Last contact outcome (one-hot vs none) | +0.50 unreachable, +0.55 refused, -0.40 promised, -0.60 part-paid |
| Days since last contact (log1p) | +0.20 |
| Overdue in EMI multiples | +0.25 |
| log outstanding | +0.15 |
| Vintage months | -0.15 |

Weights are expert priors and illustrative. Label them as assumptions.

Reasons: contribution of feature j is `beta_j * (x_j - mean_j)` (linear SHAP). Keep positive contributions, sort descending with fixed feature-order tie-break, take top 3, map each to a templated phrase in English and Hindi with the evidence ("1 broken promise in 90 days", "No contact for 9 days"). Unit test: `b0 + sum(c_ij) == logit(p_i)` within 1e-9.

Worklist order: by rupees at risk `p_roll * overdue_amount`, show score beside it. A promise due today pins to the top. Loans with `p_roll < 0.10` and no broken promise go to a "nudge only" lane (message, not visit). Store both numbers.

When it is wrong: score is advisory; managers can reorder lists (store the override and who did it); weekly back-test compares scores to actual outcomes.

Fallback: missing features are imputed with the portfolio mean and shown as "limited data". If scoring throws, order by broken promise, then DPD, then overdue amount, and label the list "standard order". Never fake the AI. Test both paths.

Back-test script: freeze scores in `score_log`, compare with the outcome 30 days later (rolled to 31+ or not), time-based split. Report AUC, decile table (n, predicted, actual, lift, cumulative captured), calibration, Brier, and the same for two baselines (DPD desc, outstanding desc). The honest value-add is the delta over the DPD baseline. State in one sentence: the data is synthetic, so this proves the pipeline works, not real-world accuracy.

## 9. Reminders (templates only)

- Pick an approved template by state, fill closed-list variables, show the officer a preview, send only on the officer's tap through the mock provider.
- Allowed variables only: `{borrower_name} {loan_last4} {due_amount} {due_date} {promise_date} {promise_amount} {paid_amount} {officer_name} {officer_phone} {nbfc_name} {pay_link} {visit_date} {visit_window}`. No DPD, no total outstanding with penalties, no family or employer names, no free text.
- Footer `{F}` on every message: `{nbfc_name} | Grievance Officer: {go_name}, {go_phone}, {go_email}, {go_address}`.
- Templates T1 to T10 (Hindi and English): pre-due, gentle overdue, promise confirmation, promise reminder, missed promise, after no contact, visit notice, payment received, hardship, call opening. Full text lives in `src/shared/templates.ts` (copy from the plan's template table). Hindi uses "आप", never "तुम".
- Template choice is deterministic: promise created -> T3; day before promise -> T4; broken promise -> T5; attempted but unreached -> T6; 1+ DPD with no promise -> T2; planned visit -> T7; hardship outcome -> T9.
- Word filter runs on template params, every free-text note and any LLM output. Normalise first (lowercase, strip punctuation and zero-width, fold Devanagari variants, transliterate common Hinglish, collapse repeats, map leet digits). Blocks: threats of harm; police/arrest/jail intimidation; public shaming or disclosure; abuse in English, Hinglish, Devanagari; coercion ("last warning", "pay or else"); family or third-party leverage; emotional manipulation; PII by regex (10-digit mobile starting 6-9, Aadhaar, PAN, email, long account numbers) except `loan_last4`; structural signals (mostly caps, more than 2 exclamation marks, weapon emoji).
- Template path rejects and logs rule code and category only. Free-text notes warn and require an edit.
- Word list is config, illustrative, needs a native reviewer. Say so in the TDD.
- LLM rephrasing is a stretch feature, default OFF. If added: it only selects a template id and tone via closed JSON schema, deterministic renderer, 5 s timeout, fallback to default template. Never put a key in the client. The demo must work with no key.
- Not in scope: DLT registration, TRAI categories.

## 10. Auto-assignment

Deterministic, loan by loan, after import:
1. Eligible officers from the territory map (locality row beats pincode row). Unmapped pincode: prefix fallback within the same branch (45201x, 4520xx, 452xxx), then branch-manager queue. Never cross branches.
2. Weight `w = 1 + 0.5[dpd>=16] + 0.5[dpd>=31] + 0.5[broken promise in last 14 days] + 0.5[outstanding >= Rs 10 lakh]`.
3. Utilisation = (sum of loan weights w) / `capacity_points`. Demo `capacity_points = 30` so caps bite at about 20 loans per officer (average w is about 1.5). There is no separate amount cap; large loans already count more through w.
4. Minimise `projected_utilisation - 0.10 (primary officer) - 0.35 (current assignee) - 0.25 (officer holds borrower's other loan)`. Soft cap 100%, hard cap 120%, tie-break on officer id. Hysteresis: keep the current officer unless improvement >= 0.15.
5. Order: carry forward still-overdue loans to existing officer (unless inactive, on leave 3+ working days, or out of territory); then assign new and orphaned loans sorted by `(-outstanding, loan_id)`; write `assignment_log` only on change. A rerun produces zero diffs.
6. Leave: 1 to 2 days only a badge and read-only handover of due-today promises to cover officer. 3+ working days reassigns temporarily keeping `home_officer_id`; on return untouched loans without an open promise revert; touched ones stay unless manager clicks "restore all".
7. Edge cases: invalid pincode -> queue + warning; all officers over cap -> assign to minimum utilisation and alert; loan reaching 61+ DPD stays assigned and flagged; no phone or address -> data-fix queue.

## 11. Daily CSV import

- Immutable batch keyed by `(as_of_date, SHA-256)`. Re-import of same bytes is a no-op. Same date with different bytes replaces that date's snapshot in one transaction under an advisory lock, then reruns assignment.
- Default contract (assumption, confirm against the real sample): full list of every loan with DPD >= 1 as of the date.
- Decode: UTF-8 BOM, UTF-16 BOM, strict UTF-8, then cp1252. Sniff delimiter (comma, semicolon, tab, pipe). NFC-normalise, strip zero-width.
- Header alias table ("LAN", "Loan A/c No", "POS", "Principal O/s", "Arrears", "Pin Code", ...). Missing required column rejects the file with nearest alias suggested.
- Amounts: Decimal to paise; strip rupee symbol, "Rs.", "/-", commas; reject "L"/"Cr" shorthand and scientific notation in mobile or loan id. Dates: day-first, accept DD/MM/YYYY, DD-MMM-YY, ISO, Excel serials.

| Rule | Severity |
|---|---|
| Missing required column; zero rows; error rate > 20%; as_of earlier than latest committed batch | Abort whole file |
| Duplicate loan_id in file (keep first) | Row error |
| Malformed pincode `^[1-9]\d{5}$`, bad DPD, bad amount, unknown branch | Row error |
| Mobile not 10 digits starting 6-9 | Warning (error if no usable phone or address) |
| Pincode not in territory map; DPD 0 (skipped) | Warning |
| DPD > 90 | Imported, flagged NPA, outside worklist |

- Diff vs previous snapshot: `new` inserts and goes to assignment (tag `late_discovery` if first seen > 30 DPD); `continuing` classed aging / part-paid / anomalous; `gone` becomes `cleared` with reason `absent_from_full_file` and auto-resolves a due promise as kept. Abort if more than 40% of yesterday's loans vanish or the file has under half the previous count.
- UI shows read, imported, updated, unchanged, skipped, errors, warnings, assignment outcomes, downloadable `errors_<batch>.csv` with Excel row numbers. Prefix any cell starting `=`, `+`, `-`, `@` with an apostrophe.
- Ship `sample_overdue.csv` and `bad_rows.csv` (2 duplicate rows, 3 malformed amounts, 1 scientific-notation mobile).
- DPD buckets: 1-30, 31-60, 61-90, over 90.

## 12. Promise tracker

- Created from a "Promise to pay" outcome. Date: today to +7 days (+10 in B2; longer needs manager approval), not a Sunday (roll forward with a visible note). Amount >= 50% of overdue and <= outstanding. One open promise per loan; max two reschedules per bucket stay; a reschedule marks the old one `superseded` (excluded from kept-rate denominator).
- `deadline = promised_date + grace_days` (default 1). `kept` when payments since creation >= 95% of promised amount; `broken` when now > deadline and paid < 95% (`broken_part` at >= 25%); a loan that clears early is kept. Kept rate = kept / (kept + broken) for promises whose deadline passed.
- Borrower reminders (T3 at creation, T4 two days before or one if lead < 3 days, T5 after a break), max 2 per promise plus 1, all held inside 08:00 to 19:00 IST, unique `(promise_id, kind)`. Officer nudges: day-before digest, morning due-today, 16:00 "call before 18:00".
- Escalation: first break -> follow-up task next morning; second -> branch manager notice and geo-tagged visit within 2 working days; third or promise > Rs 2 lakh -> manager review; 2 days past due with no action -> manager stuck-promise list.
- Edge cases: posting lag (extra working day if no payment feed), disputed promise (pause reminders, exclude from broken stats), officer on leave (cover inherits).

## 13. Roll rate and manager view

- Cohort roll rate for window `[t0, t1]` (t1 = t0 + 30 days): share of loans in 1-30 DPD at t0 that are 31+ DPD at t1, same loan ids, attributed to opening officer and branch. Outcomes cured / stayed / rolled sum to 100%. Use opening outstanding in numerator and denominator for the balance version. Never divide closing B2 balance by opening B1 balance. Immature windows show "pending", never zero.
- SQL:
```sql
WITH c AS (SELECT * FROM loan_snapshot WHERE as_of = :t0 AND dpd BETWEEN 1 AND 30),
     e AS (SELECT * FROM loan_snapshot WHERE as_of = :t1)
SELECT c.branch_id, count(*) AS cohort_n,
  count(*) FILTER (WHERE e.loan_id IS NULL OR e.dpd = 0) AS cured_n,
  count(*) FILTER (WHERE e.dpd BETWEEN 1 AND 30) AS stayed_n,
  count(*) FILTER (WHERE e.dpd >= 31) AS rolled_n,
  sum(c.outstanding) AS cohort_amt,
  sum(c.outstanding) FILTER (WHERE e.dpd >= 31) AS rolled_amt
FROM c LEFT JOIN e USING (loan_id) GROUP BY ROLLUP (c.branch_id);
```
- Persist nightly in `roll_cohort` (idempotent upsert).
- Dashboard order: tiles (roll B1 to B2 by count and amount vs 16% target, loans to save = `ceil((roll% - 16%) * n)`, promise kept rate, open broken promises, queue count, blocked attempts), 6-month trend with dashed target, branch table, officer table (grey out n < 30, Wilson 95% interval), migration table, broken-promise list (amount and age, escalate action), exceptions list (25 to 30 DPD, no promise, no contact in 5 days).
- Every chart footnote: numerator, denominator, count vs balance, cohort type, "synthetic data". Branch totals must equal sum of officers (footing test).

## 14. Seed data

- About 180 loans generated through the real importer (not by writing dashboard tables). TypeScript seedable PRNG; `seed_config.yaml` holds every rate; `pnpm seed -- --seed 20261103 --as-of today`. Dates relative to run date. Manager-only "reset demo" button re-bases dates.
- Output: about 21 daily CSVs (skip Sundays), month-end snapshots for the prior two months (three trend points), `officers.csv`, `territory.csv`.
- 9 fictional officers + 3 managers; 3 branches: Indore (4 officers), Dewas (2), Ujjain (2) serving Ratlam (1). Loan split: Indore 90, Ujjain 35, Ratlam 20, Dewas 35. Segments 45% manufacturers, 45% traders, 10% services. Include the three brief sample rows (LN-10293, LN-10871, LN-11930).
- Ticket lognormal median Rs 6 lakh sigma 0.6, clipped Rs 1.5 to 25 lakh; outstanding 55 to 95% of disbursed; rates 16 to 28%. DPD mix 75% in 1-30, 25% in 31-60. Bounces Poisson(0.9) cap 6; broken promises Poisson(0.6) cap 4; kept rate Beta(5,2); vintage 3 to 35 months.
- Demo story: about 12 promises due today, 15 within 3 days, 8 in grace, 14 broken in last 7 days, 40 kept historically; one officer with an empty list (empty state); some Hindi-only notes; 8% missing alt mobile, 5% missing business name, 3% unmapped pincode.
- Fictional names only (Malwa-style first names and surnames; firms like "Kshipra Namkeen Udyog"). UI shows "(demo)"; `is_demo = true`. No PAN, Aadhaar or GST values. Phones displayed masked; mock provider is the only send path.
- Everything is an assumption. List each distribution in the TDD.

## 15. UI and design

- One-handed, low-end Android. Targets 48 dp minimum, 56 dp primary, 8 dp gaps. Primary actions in the bottom 40%. At most 3 bottom tabs. No hamburger or swipe-only gestures.
- Outcome in 3 taps: open loan, tap sticky "Log outcome", tap one large chip (Paid, Promise to pay, Not reachable, Refused, Wrong number). Saves with defaults; 5-second Undo toast; details in optional "Add details". Promise offers Today / Tomorrow / +3 days chips with overdue amount prefilled.
- Minimal, restrained: CSS variable tokens; one 9-step cool-grey neutral scale; one deep-teal accent; semantic colour only for status; single-hue sequential ramp for DPD buckets with text labels; type scale 12/14/16/18/22/28/36; tabular numerals for money; 4 px spacing; one radius; borders not shadows; Lucide icons at one stroke width; 150 to 200 ms motion respecting `prefers-reduced-motion`.
- Light theme, 7:1 contrast for body text, body 16 to 18 px, key numbers 24 to 32 px. JS budget about 150 KB gzipped on the officer route; chart code only on the manager route. Skeletons, not spinners.
- Hindi: self-hosted subset of Noto Sans Devanagari or Mukta, `font-display: swap`, about 1.1x Latin size, line-height 1.5 to 1.6, `lang="hi"`, buttons grow rather than truncate. Polite "आप". One dictionary file with parameters, never concatenated fragments. Mark "native review pending". Latin digits with lakh/crore grouping in both languages via a tested `formatLakhCrore()` (cases 999; 1,000; 99,999; 1,00,000; 1,00,00,000).
- No map tiles in the officer app: Map button is a `geo:` or maps deep link.
- Copy examples: "All caught up, no visits assigned today"; "Couldn't reach server. Your 3 updates are saved on this phone and will sync automatically"; "Location off. You can still log the visit; we'll skip the location"; "Suggestions unavailable. Showing standard order"; "Contact allowed 8 am to 7 pm".

## 16. Security and privacy (build items)

- Secrets: `.gitignore` before first commit, `.env.example` names only, gitleaks pre-commit and CI. Never commit values.
- Auth: hashed passwords, HttpOnly Secure SameSite=Lax cookies, session expiry, login rate limit, generic error text. Demo logins from env with `DEMO_MODE` off switch.
- Authz: officer sees only own assigned loans; manager scoped to branch. Tests prove isolation. No export for officers.
- Input: Zod on every body; 5 MB and row-count limits on upload; MIME and extension check; parameterised queries; CSV formula-injection guard on exports.
- Data minimisation: never store PAN, Aadhaar or bank details. Mask phones by role on the server (`98XXXXXX21`); never send full numbers to the officer client; reveal is audited, in-window, rate-limited. Offline assignment cache expires at 24 h and is wiped on logout.
- Headers: HTTPS only, HSTS, CSP, `X-Content-Type-Options`, `frame-ancestors 'none'`, `Referrer-Policy`.
- Logging: append-only `audit_log` for logins, imports, reveals, exports, rule blocks. Scrub PII from app logs.
- Privacy (design and document only): DPDP notice and consent, 72-hour breach reporting, log retention at least 1 year, call recordings 6 months, India-hosted data. Open legal question: whether DPDP s.7(a) covers collection visits. Say "not legal advice".

## 17. Tests (80 to 100 assertions, named by rule)

Contact window; sync and idempotency; import; assignment; scoring (additivity, top-3 order, fallback, back-test on fixed seed); promises; roll rate (footing, pending, Wilson, migration rows sum to 1); reminders and filter (slot validation, footer present, obfuscated threats, Hinglish and Devanagari, PII regex); access control; formatters; one Playwright path (login, switch to Hindi, log outcome, offline, reload, see "1 pending", online, exactly one server row) against a production build.

CI: lint, typecheck, Vitest, gitleaks, Playwright.

## 18. Conventions

- Conventional commits, atomic: `feat(sync): idempotent batch endpoint`. Aim for 35 to 45 commits. Never squash history.
- Tests first for anything in `src/shared`. A task is done only when tests pass and the build is green.
- Do not add a dependency without saying why and what it replaces.
- No dead buttons. If something is not built, it is not in the UI.
- Keep `docs/log.md` (one line per day), `docs/assumptions.md` (A1, A2, ...), `docs/adr/` (short ADRs).
- Label every assumption. Distinguish measured from estimated numbers. Say plainly that data is synthetic and that nothing is known about the company beyond the brief.
- Do not invent facts about the client or the regulator. If unsure, add it to `docs/assumptions.md`.

## 19. Never cut

CSV import with validation and error report; assignment; priority list with score and top 3 reasons; offline outcome logging with idempotent sync; contact-window block; promise tracker; roll-rate view; Hindi officer UI; tests for key logic; basic security; TDD and deployment.md; a deployed demo that does not cold-start badly.

Cut first (in order): LLM rephrasing; Playwright e2e (keep Vitest simulation); manager map and GPS distance checks; Background Sync registration; migration heatmap and Wilson intervals; manager-screen Hindi; leave-cover and rebalancing; back-test UI panel (keep script); entry-cohort view; header-mapping preview UI.

## 20. Decisions made after orientation (these override anything above)

1. Branches: three branch rows (Indore, Dewas, Ujjain). The Ratlam officer belongs to the Ujjain branch, territory carries Ratlam pincodes, and Ratlam loans have `branch_id = Ujjain`. Assumption.
2. Rule-set switch: `attempt_date_ist < 2027-01-01` uses `RBC2025_para100`, otherwise `RECOVERY2026_100Y`. Both are 08:00 to 19:00. The name says 2026 because that is the direction's issue date; it takes effect 1 Jan 2027.
3. Roll behaviour in the seed targets about 22% for the opening cohort. Record it in `docs/assumptions.md`.
4. Capacity: utilisation = sum of weights / `capacity_points` (see section 10). Record as an assumption.
5. Trend chart: 3 points are fine for now. If time allows on Day 3, generate 6 monthly snapshots (cheap, same generator). Otherwise label the chart "3 months, synthetic".
6. Playwright stays out of default CI until the app exists. It is on the cut list.
7. Region: try `"regions": ["bom1"]` for the Vercel function in `vercel.json` and pick the closest available Neon region. If either is not available on the free tier, state the actual region in the TDD as an assumption. Not a blocker.
8. Toolchain: check installed Node and pnpm before the first commit. Run `npm view <pkg> version time.modified` before pinning.
9. File name: the spec file is `SPEC.md`. Rename `Spec.md` to `SPEC.md` in the first commit.