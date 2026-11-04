import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { applyImport } from './import/applyImport.js';
import { validateAsOf, validateUploadFile } from './import/uploadMeta.js';
import { buildErrorsCsv } from './errorsCsv.js';
import { fetchBatchWithRowErrors, isManager, resolveActor } from './dal.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.post('/api/import', async (c) => {
  try {
    const actor = await resolveActor(c.req.header('Authorization'));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!isManager(actor)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart form-data with a csv file is required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'a csv file field named "file" is required' }, 400);
    }
    const fileCheck = validateUploadFile(file);
    if (!fileCheck.ok) {
      return c.json({ error: fileCheck.error }, fileCheck.code === 'too_large' ? 413 : 415);
    }
    const asOfField = form.get('as_of');
    const asOfCheck = validateAsOf(asOfField === null ? undefined : String(asOfField));
    if (!asOfCheck.ok) {
      return c.json({ error: asOfCheck.error }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await applyImport({
      bytes,
      filename: file.name,
      asOf: asOfCheck.asOf,
      actor: { userId: actor.userId, username: actor.username }
    });
    if (outcome.status === 'rejected') {
      return c.json({ status: 'rejected', abort: outcome.abort, report: outcome.counts }, 422);
    }
    return c.json({ status: outcome.status, batchId: outcome.batchId, report: outcome.report });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});

app.get('/api/import/:id/errors.csv', async (c) => {
  try {
    const actor = await resolveActor(c.req.header('Authorization'));
    if (!actor) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!isManager(actor)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'not found' }, 404);
    }
    const found = await fetchBatchWithRowErrors(id);
    if (!found) {
      return c.json({ error: 'not found' }, 404);
    }
    const csv = buildErrorsCsv(found.rows);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="errors_${found.batch.id}.csv"`
      }
    });
  } catch {
    return c.json({ status: 'degraded' }, 503);
  }
});
