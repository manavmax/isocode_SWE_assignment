# ER diagram

Mermaid ER for the SPEC.md section 5 minimum data model. Money is stored in integer paise (`bigint`-backed, safe for Rs 25 lakh+ tickets: ~2.5e9 paise overflows `int32`). Instant timestamps are `timestamptz` (UTC); day-based fields (`as_of`, `promised_date`, cohort bounds) are `date` in IST-day terms, matching import contract "as of date".

```mermaid
erDiagram
    BRANCH ||--o{ OFFICER : "has"
    BRANCH ||--o{ APP_USER : "scopes role"
    OFFICER ||--o{ APP_USER : "linked profile"
    OFFICER ||--o{ TERRITORY : "owns rows"
    OFFICER ||--o{ OFFICER_ABSENCE : "leave window"
    BRANCH ||--o{ TERRITORY : "pincode scope"
    BRANCH ||--o{ LOAN : "originates"
    OFFICER |o--o{ LOAN : "assigned_officer_id"
    OFFICER |o--o{ LOAN : "home_officer_id"
    LOAN ||--o{ LOAN_SNAPSHOT : "daily rows"
    LOAN ||--o{ IMPORT_ROW_ERROR : "row_no"
    IMPORT_BATCH ||--o{ IMPORT_ROW_ERROR : "batch"
    IMPORT_BATCH }o--|| IMPORT_BATCH : "same (as_of, sha256) unique"
    LOAN |o--o{ ASSIGNMENT_LOG : "reason on change"
    LOAN ||--o{ CONTACT_EVENT : "attempted_at_ist"
    OFFICER |o--o{ CONTACT_EVENT : "did the attempt"
    CONTACT_EVENT |o--o{ CONTACT_EVENT : "superseded_by new event with corrects_event_id"
    LOAN ||--o{ PROMISE : "one open at a time"
    PROMISE |o--o{ PROMISE : "superseded_by"
    CONTACT_EVENT |o--o{ PROMISE : "created from outcome"
    LOAN ||--o{ PAYMENT : "posted"
    LOAN ||--o{ MESSAGE_OUTBOX : "template ids"
    PROMISE |o--o{ MESSAGE_OUTBOX : "unique (promise_id, kind)"
    OFFICER |o--o{ PROMISE : "holding officer"
    LOAN ||--o{ SCORE_LOG : "ranked worklist"
    BRANCH ||--o{ ROLL_COHORT : "branch roll"
    OFFICER |o--o{ ROLL_COHORT : "opening officer"
    APP_USER |o--o{ IMPORT_BATCH : "created_by"
    APP_USER ||--o{ AUDIT_LOG : "actor"
```

Invariants recorded in migrations:
- `loan_snapshot` PK `(as_of, loan_id)` — one snapshot row per loan per day.
- `import_batch` UNIQUE `(as_of, file_sha256)` — same bytes on the same date is a no-op.
- `message_outbox` UNIQUE `(promise_id, kind)` — promiseless rows (`promise_id IS NULL`) are exempt by Postgres NULL semantics (intentional).
- `territory` UNIQUE NULLS NOT DISTINCT `(branch_id, pincode, locality, officer_id)` and `roll_cohort` UNIQUE NULLS NOT DISTINCT `(t0, t1, branch_id, officer_id)` — dedupe exact rows while still allowing one pincode-generic row per officer.
- `contact_event` is append-only by TRIGGER (`BEFORE UPDATE OR DELETE` raises; corrections supersede with `corrects_event_id`).
- `score_log` UNIQUE `(loan_id, as_of)` — one row per scoring run per day; immutability is a write-layer rule for Day 1 (trigger hardening is deferred to the TDD appendix).

Notes:
- Indore / Dewas / Ujjain are the three `branch` rows; the Ratlam officer and Ratlam loans belong to Ujjain (SPEC section 20, assumption A3).
- `bigint { mode: 'number' }` is used for paise so 25 lakh tickets (~2.5e9) do not overflow `int32`; all values stay far below 2^53.
