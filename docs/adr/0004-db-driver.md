# ADR-0004: neon-http is for simple reads; pooled driver required for transactional writes

Date: 2026-11-04. Status: accepted (finding + decision point).

**Context.** The health endpoint and other simple reads run on `drizzle-orm/neon-http` (HTTP, one fetch per query). The importer (SPEC 11) must replace a date's snapshot "in one transaction under an advisory lock", and the sync batch endpoint (SPEC 6) inserts many then re-derives promise state server-side.

**Finding (verified against pinned `drizzle-orm@0.45.4`, `@neondatabase/serverless@1.2.0`, and Neon docs 2026-10-05).**
1. `NeonHttpDatabase.transaction()` throws at runtime: "No transactions support in neon-http driver" (neon-http/session.js). Drizzle's `batch()` maps to Neon HTTP `sql.transaction([...])`, which is a **non-interactive** transaction: all statements pre-built, one HTTP round trip, no application logic between statements.
2. Neon HTTP mode supports single queries and non-interactive transactions only. Interactive transactions and sessions require `Pool`/`Client` over WebSockets (`drizzle-orm/neon-serverless`, present in 0.45.4). Node 22+ has a built-in WebSocket, so no `ws` package is required. HTTP request/response cap is 64 MB.
3. `pg_advisory_xact_lock` holds only until the current transaction ends. Under neon-http single-statement autocommit (health, simple reads) it releases immediately and protects nothing. It is usable only inside a single batched transaction or a pooled (interactive) transaction.

**Decision point (for the importer and the sync batch endpoint).** Both need multi-step logic between statements (`SELECT pg_advisory_xact_lock`, staging, snapshot replace, row-error writes; per-event insert then promise re-derivation). Expressing all of that as one pre-built SQL batch is unmaintainable. Therefore: those two paths use the pooled driver — `@neondatabase/serverless` `Pool` + `drizzle-orm/neon-serverless` over the built-in WebSocket on the Node runtime (`pg` on a Neon pooled connection string remains an equivalent fallback). Simple reads keep neon-http.

**Consequences.** Two driver paths then live behind `src/server/db.ts` (never in route handlers; the DAL owns them). Pooled connections are per-request on serverless: create, use, and close within the handler. Hot paths gaining a WS handshake on first import/sync of an invocation is accepted for Day 1; cold-start stays dominated by function boot, and a follow-up can pool-reuse per invocation. If either path later needs pure-SQL-only batches, neon-http `transaction()` remains a documented option for that shape.
