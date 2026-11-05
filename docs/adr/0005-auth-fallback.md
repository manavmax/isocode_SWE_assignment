# ADR-0005: hand-rolled DB sessions instead of an auth framework

- SPEC boxes Better Auth at 45 minutes; it did not sit cleanly, so we take the exact fallback SPEC names: DB sessions.
- Implementation: the existing `node:crypto` scrypt PIN hashes (per-user salt), a `session` table, an HttpOnly Secure SameSite=Lax cookie, 7-day expiry, a login rate limit whose counter lives in a DB table (`login_attempt`, so it holds across serverless instances), generic error text.
- Demo logins come from the demo seed config and are gated by `DEMO_MODE` (A31).
- Why: time-boxed take-home, fewer moving parts, and auth is not the product — no middleware or vendor surface to upgrade.
- Consequence: the `session` table joined to `app_user` is the only source of truth for a logged-in request; nothing else carries identity.
