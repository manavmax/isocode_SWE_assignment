# Work log

One line per day; includes what broke and why.

- 2026-11-04: Day 1 scaffold. Pin recon via `npm view` (vite 8.3.5, vite-plugin-pwa 1.3.0 not 2.x — untested vs vite 8, hono 4.13.16, drizzle-orm 0.45.4 + drizzle-kit 0.31.11, dexie 4.4.7, vitest 5.1.0, zod 4.6.7, typescript 5.9.3 since typescript-eslint 8.72.1 caps TS <6.1.0). Installed pnpm 12.16.1 via corepack, gitleaks 8.30.1 via brew. CI: lint + typecheck + vitest + gitleaks; gitleaks also pre-commit via simple-git-hooks. No push yet.
