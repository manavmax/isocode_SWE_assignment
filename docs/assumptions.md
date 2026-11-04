# Assumptions register

Every number, distribution, threshold or encoder choice the tooling or brief implies is listed here and labelled. Data is synthetic; nothing about the client is known beyond SPEC.md.

- A1: All data in this project is synthetic. No real borrower, firm, phone number or amount exists anywhere, including seed output.
- A2: Nothing is known about Company A beyond the brief (SPEC.md §1). No facts about the client or the regulator are invented; unclear items land here instead.
- A3: Ratlam has no branch row. Its one officer belongs to the Ujjain branch, Ratlam loans carry `branch_id = Ujjain`, and `territory` rows carry Ratlam pincodes (approved 2026-11-04).
- A4: Contact rule-set selection is by attempt date: `attempt_date_ist < 2027-01-01` -> `RBC2025_para100`, else `RECOVERY2026_100Y`. Both enforce 08:00-19:00 IST (approved 2026-11-04).
- A5: Seed targets about 22% roll behaviour for the opening cohort to match the scorecard baseline `logit(0.22)`; the dashboard target remains 16% (approved 2026-11-04).
- A6: Assignment utilisation = sum of loan weights / capacity_points, with no separate amount cap; large loans already pull more weight (approved 2026-11-04).
- A7: vite-plugin-pwa pinned at 1.3.0, not 2.0.0. 1.3.0 declares peer support for vite ^8; 2.0.0 is untested here and stays unused until a spike proves it (per standing instruction).
- A8: TypeScript pinned at 5.9.3 (not 7.0.2): typescript-eslint 8.72.1 declares peer support only up to <6.1.0, so 7.x would break the lint stack.
- A9: The gitleaks pre-commit hook requires the gitleaks binary on the contributor's machine (installed via brew here); CI carries the gitleaks job so history is still scanned if a local binary is missing.
- A10: The daily CSV contract is assumed to be "full list of every loan with DPD >= 1 as of the date" (SPEC.md §11 default); to be confirmed against the real sample file before it matters.
