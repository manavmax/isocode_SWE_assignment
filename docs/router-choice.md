Router choice (prompt 9.5): hand-rolled, 60 lines in src/client/router.ts.
- Justification: SPEC 3 says avoid extra libraries and the app has exactly 4 routes (/login, /today, /loans/:id, /me) with no nesting, no loaders, no data APIs. react-router adds ~20 KB gzip to the officer route against a 150 KB budget and wouter ~1.5 KB still covers nothing we need beyond history.pushState + popstate.
- Replaces: react-router / wouter. Zero new dependencies.
