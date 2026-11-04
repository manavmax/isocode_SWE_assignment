import { neon, Pool } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePooled } from 'drizzle-orm/neon-serverless';

export function getDb(): NeonHttpDatabase {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return drizzle(neon(url));
}

type PooledDb = ReturnType<typeof drizzlePooled>;
type PooledTx = Parameters<Parameters<PooledDb['transaction']>[0]>[0];

let pool: Pool | null = null;
let pooledDb: PooledDb | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export function getPooledDb(): PooledDb {
  if (!pooledDb) {
    pooledDb = drizzlePooled(getPool());
  }
  return pooledDb;
}

export async function withTx<T>(fn: (tx: PooledTx) => T | Promise<T>): Promise<T> {
  return getPooledDb().transaction(async (tx) => fn(tx));
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    pooledDb = null;
    await closing.end();
  }
}

export type { PooledTx };
