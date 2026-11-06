# Screens (prompt 9 check + prompt 10b offline sync)

Captured with Playwright (dev dependency only, no CI test) at 390x844 (deviceScaleFactor 2, so PNGs are 780x1688) against the dev server (`pnpm dev:api` + `pnpm dev`) with DEMO_MODE on and the real seeded Neon database. Script: `scripts/screenshots.mjs` (`node scripts/screenshots.mjs`).

Layout audit: `scripts/layout-audit.mjs` — checks horizontal overflow, tap-target sizes (>= 44 px) and text truncation on every screen AND every sheet state (outcome, promise chips, undo toast, blocked-by-window, Me sync section) in both languages; 16/16 states clean after the fixes it found across prompt 9 and 10b (prompt 9: compounding `:lang(hi)` font-size, a `min-width: max-content` overflow; prompt 10b: sync pill 32 px, Sync now 32 px, Undo 29–33 px — all raised to the 48 px token, and both scripts hardened against orphan dev servers).

| File | Screen | Language |
|---|---|---|
| login-hi.png | Login: language buttons, username + numeric PIN | Hindi |
| login-en.png | Login | English |
| today-en.png | Today: date header, visits, DPD-desc cards, sync pill in the header | English |
| today-hi.png | Today | Hindi |
| detail-en.png | Loan detail: facts, masked phones, sticky bar (Call, Map, Log outcome) | English |
| detail-hi.png | Loan detail | Hindi |
| outcome-en.png | Outcome sheet: Call/Visit toggle, five chips, Add details | English |
| outcome-hi.png | Outcome sheet | Hindi |
| outcome-promise-en.png | Promise date chips (Today/Tomorrow/+3), amount prefilled | English |
| outcome-promise-hi.png | Promise date chips | Hindi |
| undo-en.png | "Saved on phone" + Undo toast (5 s hold before the item can sync) | English |
| undo-hi.png | Undo toast | Hindi |
| blocked-en.png | Blocked-by-window sheet (clock frozen at 22:00 IST; Call muted but tappable) | English |
| blocked-hi.png | Blocked-by-window sheet | Hindi |
| me-en.png | Me: Sync section (pending/failed/synced counts, item list, Sync now, last sync, persistence) | English |
| me-hi.png | Me | Hindi |
| today-empty-en.png | Empty state: "All caught up..." + Refresh action (route stubbed to zero assignments) | English |
| today-empty-hi.png | Empty state | Hindi |
| today-error-en.png | Error state: Retry (route aborted, no cache) | English |
| today-error-hi.png | Error state | Hindi |
| today-offline-en.png | Offline banner over cached list (context set offline after one online load) | English |

The blocked sheet is captured by freezing the page clock with Playwright's clock API (`page.clock.setFixedTime` at 16:30Z = 22:00 IST), which drives the same skew-corrected window check the officer's phone runs at night. The undo/me shots carry one real queued event (Paid outcome), so the sync section shows live counts and per-item chips.

## Size report (officer route, production build, after prompt 10b)

- `dist/assets/index-*.js`: 453.47 kB raw, **139.25 kB gzipped** — against the ~150 KB gzipped budget (SPEC 15): **139.25 / 150 = 93% of budget, 10.75 kB headroom** (up from 106.35 kB after prompt 9: the sync engine, outbox layer, outcome/blocked sheets, GPS watcher and reveal flow cost ~33 kB gzip).
- `dist/assets/index-*.css`: 3.57 kB gzipped (was 2.38 kB — sheet/sync styles).
- The app is a single bundle at this stage (officer screens only, no manager route yet); React+react-dom ≈ 39 kB gzip and Dexie ≈ 8 kB gzip remain the biggest libraries in it. Manager-only code (charts, import UI) will be a separate lazy chunk before any budget pressure.
- Fonts are separate precached assets (~64 KB total for 2 weights x 2 subsets, loaded per unicode-range) and do not count against the JS budget.
- PWA: 13 precache entries (589 KiB uncompressed), shell only (html + js + css + woff2 + icons); no runtime caching — the outbox lives in IndexedDB, not the service worker.
