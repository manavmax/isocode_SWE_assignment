import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { Pool } from '@neondatabase/serverless';

const TABLES = [
  'branch',
  'app_user',
  'officer',
  'officer_absence',
  'territory',
  'loan',
  'loan_snapshot',
  'import_batch',
  'import_row_error',
  'assignment_log',
  'contact_event',
  'promise',
  'payment',
  'message_outbox',
  'score_log',
  'roll_cohort',
  'audit_log'
] as const;

const PROBE_ID = '00000000-0000-4000-8000-000000000001';

failUnless(process.env.DATABASE_URL, 'DATABASE_URL is not set');

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool);

try {
  const tables = await db.execute<{ table_name: string }>(
    sql`select table_name as table_name from information_schema.tables where table_schema = 'public'`
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const missing = TABLES.filter((name) => !present.has(name));
  failUnless(missing.length === 0, `missing tables: ${missing.join(', ')}`);
  console.log(`db-check: all ${TABLES.length} tables present`);

  const triggers = await db.execute<{ tgname: string }>(
    sql`select tgname as tgname from pg_trigger where tgrelid = 'contact_event'::regclass and not tgisinternal`
  );
  const hasPostgresTrigger = triggers.rows.some((row) => row.tgname === 'contact_event_append_only');
  failUnless(hasPostgresTrigger, 'trigger contact_event_append_only is not installed');
  console.log('db-check: trigger contact_event_append_only present');

failUnless((await cascadeCount()) === 0, 'a foreign key cascades deletes into contact_event');
console.log('db-check: no foreign key cascade deletes into contact_event');

await expectRejected('update contact_event set outcome = $$tampered$$ where id = $1', 'UPDATE');
await expectRejected('delete from contact_event where id = $1', 'DELETE');


  console.log('db-check: UPDATE and DELETE on contact_event both rejected inside rolled-back transactions');
  console.log('db-check OK');
} finally {
  await pool.end();
}

async function cascadeCount() {
  const result = await db.execute<{ fk: string; delete_rule: string }>(
    sql`select conname as fk, confdeltype::text as delete_rule
        from pg_constraint
        where confrelid = 'contact_event'::regclass`
  );
  return result.rows.filter((row) => row.delete_rule === 'c').length;
}

async function expectRejected(statement: string, targetOp: 'UPDATE' | 'DELETE') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `insert into branch (id, code, name) values (gen_random_uuid(), '__DBCHECK__', '__dbcheck probe branch') returning id`
    ).then((result) =>
      client.query(
        `insert into loan (loan_id, borrower_name, branch_id, outstanding, overdue_amount, dpd, bucket)
         values ('__dbcheck_probe_loan__', '__dbcheck probe loan__', $1, 0, 0, 0, '0')`,
        [(result.rows[0] as { id: string }).id]
      )
    ).then(() =>
      client.query(
        `insert into contact_event (id, loan_id, kind, attempted_at_device, device_tz_offset_minutes, attempted_at_ist, within_window, rule_set)
         values ($1, $2, 'CALL', '2026-01-01 06:00:00+00', 0, '2026-01-01 06:00:00+00', true, 'RBC2025_para100')`,
        [PROBE_ID, '__dbcheck_probe_loan__']
      )
    ).then(() =>
      client.query(statement, [PROBE_ID])
    ).then(
      () => failUnless(false, `${targetOp} on contact_event was not rejected`),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        failUnless(
          message.includes('append-only') && message.includes(targetOp),
          `${targetOp} failed for the wrong reason: ${message}`
        );
        console.log(`db-check: ${targetOp} rejected with trigger error (inside probe transaction)`);
      }
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`db-check FAILED: ${message}`);
    process.exit(1);
  }
}
