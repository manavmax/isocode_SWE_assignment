import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';

export const app = new Hono();

app.get('/api/health', async (c) => {
  try {
    const db = getDb();
    await db.execute(sql`select 1 as ok`);
    return c.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
  } catch {
    return c.json({ status: 'degraded', db: 'error', time: new Date().toISOString() }, 503);
  }
});
