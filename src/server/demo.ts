/**
 * Demo accounts (SPEC 1 demo-account chips, SPEC 26 "Demo logins from env with
 * DEMO_MODE off switch"). Everything here is synthetic (A1) and the demo PIN is
 * a documented demo credential (docs/deployment.md), hashed at rest with the
 * same scrypt as real users — never a real secret (A31).
 *
 * Scope: this module creates ONLY its own branch, demo officers and demo
 * users; it never touches loans, territory, contacts or audit data. The full
 * seed (SPEC 13) will call ensureDemoAccounts with DEMO_MODE=true.
 */
import { asc, eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { hashPassword } from './auth.js';
import { branches, officers, users } from './db/schema.js';

/** Fails the idempotent-setup step hard instead of continuing with a null row. */
function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Documented demo credential (A31, docs/deployment.md): FOR DEMO USE ONLY,
 * created at seed time, hashed in the database, and it only logs in while
 * DEMO_MODE=true. */
export const DEMO_PIN = '1234';

export const DEMO_BRANCH_CODE = 'UJJAIN';
export const DEMO_BRANCH_NAME = 'Ujjain';

export const DEMO_ACCOUNTS = [
  { username: 'demo-manager', role: 'branch_manager', officerName: null, officerUser: false },
  { username: 'demo-officer-1', role: 'field_officer', officerName: 'Demo Officer 1', officerUser: true },
  { username: 'demo-officer-2', role: 'field_officer', officerName: 'Demo Officer 2', officerUser: true }
] as const;

/** Login gate: demo accounts sign in only while DEMO_MODE is on (A31). Full
 * generic error text at the route layer — this never reveals which usernames
 * are demo accounts. */
export function demoLoginAllowed(isDemoUser: boolean, demoModeEnabled: boolean): boolean {
  return !isDemoUser || demoModeEnabled;
}

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
}

export interface DemoAccountsSummary {
  branchId: string;
  usernames: string[];
}

/** Idempotent: safe to run again after a seed; users follow the branch and
 * officer the config names, and their (hashed) PIN follows the config. */
export async function ensureDemoAccounts(db: NeonHttpDatabase, branchCode: string = DEMO_BRANCH_CODE): Promise<DemoAccountsSummary> {
  const passwordHash = hashPassword(DEMO_PIN);

  let branchRow = (await db.select({ id: branches.id }).from(branches).where(eq(branches.code, branchCode)).limit(1))[0];
  if (!branchRow) {
    const inserted = (
      await db
        .insert(branches)
        .values({ code: branchCode, name: DEMO_BRANCH_NAME })
        .onConflictDoUpdate({ target: branches.code, set: { name: DEMO_BRANCH_NAME } })
        .returning({ id: branches.id })
    )[0];
    failUnless(inserted, `demo: branch insert for ${branchCode} returned no row`);
    branchRow = inserted;
  }
  const branchId = branchRow.id;

  const officerIds = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    if (!account.officerUser) {
      continue;
    }
    const officerName = account.officerName!;
    let officerRow = (
      await db.select({ id: officers.id }).from(officers).where(eq(officers.name, officerName)).orderBy(asc(officers.id)).limit(1)
    )[0];
    if (!officerRow) {
      const inserted = (await db.insert(officers).values({ branchId, name: officerName, active: true, capacityPoints: 30 }).returning({ id: officers.id }))[0];
      failUnless(inserted, `demo: officer insert for '${officerName}' returned no row`);
      officerRow = inserted;
    }
    officerIds.set(account.username, officerRow.id);
  }

  const usernames: string[] = [];
  for (const account of DEMO_ACCOUNTS) {
    const officerId = officerIds.get(account.username) ?? null;
    await db
      .insert(users)
      .values({ username: account.username, passwordHash, role: account.role, branchId, officerId, active: true, isDemo: true })
      .onConflictDoUpdate({
        target: users.username,
        set: { passwordHash, role: account.role, branchId, officerId, active: true, isDemo: true }
      });
    usernames.push(account.username);
  }

  return { branchId, usernames };
}
