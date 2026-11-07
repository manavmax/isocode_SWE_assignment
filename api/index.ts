import { app } from '../src/server/app.js';

/** Single Vercel Function for every /api path (Vercel Functions quickstart:
 * "Keep related routes in a shared function"). One-segment file names only
 * match their exact path on the Vercel filesystem router, so vercel.json
 * rewrites /api/(.*) -> /api to reach this handler; the rewrite is internal
 * and Hono sees the ORIGINAL request URL with its full /api/... path. */
export default {
  fetch: app.fetch
};
