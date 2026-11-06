# Screens (prompt 9 check)

Captured with Playwright (dev dependency only, no CI test) at 390x844 (deviceScaleFactor 2, so PNGs are 780x1688) against the dev server (`pnpm dev:api` + `pnpm dev`) with DEMO_MODE on and the real seeded Neon database. Script: `scripts/screenshots.mjs` (`node scripts/screenshots.mjs`). Layout audit: `scripts/layout-audit.mjs` (checks horizontal overflow, tap-target sizes, text truncation on every screen in both languages; all zero problems after two fixes it caught — a compounding `:lang(hi)` font-size that pushed body text to 19.4px, and a `min-width: max-content` rule that made Hindi Today cards overflow by 49px).

| File | Screen | Language |
|---|---|---|
| login-hi.png | Login: language buttons, username + numeric PIN | Hindi |
| login-en.png | Login | English |
| today-en.png | Today: date header, 21 visits, DPD-desc cards, large overdue, bucket chip, no phone | English |
| today-hi.png | Today | Hindi |
| detail-en.png | Loan detail: facts, masked phones, Maps deep link only (no Call/Log buttons) | English |
| detail-hi.png | Loan detail | Hindi |
| me-en.png | Me: account, language toggle, logout | English |
| me-hi.png | Me | Hindi |
| today-empty-en.png | Empty state: "All caught up..." + Refresh action (route stubbed to zero assignments) | English |
| today-empty-hi.png | Empty state | Hindi |
| today-error-en.png | Error state: Retry (route aborted, no cache) | English |
| today-error-hi.png | Error state | Hindi |
| today-offline-en.png | Offline banner over cached list (context set offline after one online load) | English |

## Size report (officer route, production build)

- `dist/assets/index-*.js`: 338.51 kB raw, **106.35 kB gzipped** — against the ~150 KB gzipped budget (SPEC 15): **106.35 / 150 = 71% of budget, 43.65 kB headroom**.
- `dist/assets/index-*.css`: 2.38 kB gzipped.
- The app is a single bundle at this stage (officer screens only, no manager route yet); React+react-dom ≈ 39 kB gzip, Dexie ≈ 8 kB gzip are the biggest libraries in it. Manager-only code (charts, import UI) will be a separate lazy chunk before any budget pressure.
- Fonts are separate precached assets (~64 KB total for 2 weights x 2 subsets, loaded per unicode-range) and do not count against the JS budget.
- PWA: 13 precache entries (470 KiB uncompressed), shell only (html + js + css + woff2 + icons); no runtime caching.
