/**
 * Demo accounts (SPEC 1 demo-account chips, SPEC 26 "Demo logins from env with
 * DEMO_MODE off switch"). Everything here is synthetic (A1) and the demo PIN is
 * a documented demo credential (docs/deployment.md), hashed at rest with the
 * same scrypt as real users — never a real secret (A31).
 *
 * Step 0.5: the demo chips no longer own officers of their own — each chip
 * LINKS to seeded staff (resolved by name/username from the database, never
 * fabricated): demo-officer-1 acts as Rahul Chouhan (Indore), demo-officer-2
 * as Neha Solanki (Dewas), demo-officer-3 is a new-joiner officer with no
 * territory rows (the empty-worklist state, deliberately), and demo-manager
 * acts as the Indore branch manager Kavita Rathore (its user row follows her
 * branch). Only the joiner officer is created here; a missing linked staff
 * member fails loudly instead — the seed must run first. The module still
 * owns branch code UJJAIN (the joiner's branch) and never touches loans,
 * territory, contacts or audit data.
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
  {
    username: 'demo-manager',
    role: 'branch_manager',
    officerName: null,
    officerUser: false,
    /** The seeded branch manager this chip acts as — its user row follows that
     *  manager's branch (resolved from the database, never fabricated). */
    linkedManagerUsername: 'kavita.rathore',
    createsOfficer: false,
    minOverdueLoans: 0
  },
  {
    username: 'demo-officer-1',
    role: 'field_officer',
    officerName: 'Rahul Chouhan',
    officerUser: true,
    linkedManagerUsername: null,
    createsOfficer: false,
    minOverdueLoans: 10
  },
  {
    username: 'demo-officer-2',
    role: 'field_officer',
    officerName: 'Neha Solanki',
    officerUser: true,
    linkedManagerUsername: null,
    createsOfficer: false,
    minOverdueLoans: 10
  },
  {
    username: 'demo-officer-3',
    role: 'field_officer',
    officerName: 'Demo Officer 3',
    officerUser: true,
    linkedManagerUsername: null,
    // The new joiner: the only officer this module creates, with no territory
    // rows, so the demo can show the empty-worklist state.
    createsOfficer: true,
    minOverdueLoans: 0
  }
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
  /** Officer id each demo officer-user acts as (managers map to nothing):
   *  the linked staff officers' own ids plus the joiner's. The seed rekeys
   *  these by officer name (territoryOfficerIds) for territory repair. */
  officerIdByUsername: Record<string, string>;
}

/** Idempotent: safe to run again after a seed. Officer chips link to the
 *  seeded staff officer named on the account (same officer row, so the same
 *  loans and worklist); only the joiner officer is created here, on the demo
 *  branch. The manager chip follows the branch of the seeded manager named on
 *  its account. Missing linked staff fails loudly — run the seed first. */
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

  // The manager chip follows the seeded manager it names (branch link — a
  // branch manager has no officer row to point at).
  const branchForUsername = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    if (account.officerUser) {
      continue;
    }
    const managerUsername = account.linkedManagerUsername;
    const managerRow = (
      await db
        .select({ id: users.id, branchId: users.branchId, role: users.role })
        .from(users)
        .where(eq(users.username, managerUsername))
        .limit(1)
    )[0];
    failUnless(managerRow, `demo: manager link '${managerUsername}' for ${account.username} not found — demo accounts link to seeded staff; run the seed first (pnpm seed)`);
    failUnless(managerRow.role === 'branch_manager', `demo: manager link '${managerUsername}' is a ${managerRow.role}, not a branch_manager`);
    branchForUsername.set(account.username, managerRow.branchId);
  }

  const officerIds = new Map<string, string>();
  for (const account of DEMO_ACCOUNTS) {
    if (!account.officerUser) {
      continue;
    }
    const officerName = account.officerName!;
    let officerRow = (
      await db
        .select({ id: officers.id, branchId: officers.branchId })
        .from(officers)
        .where(eq(officers.name, officerName))
        .orderBy(asc(officers.id))
        .limit(1)
    )[0];
    if (!officerRow) {
      failUnless(
        account.createsOfficer,
        `demo: officer '${officerName}' linked by ${account.username} does not exist — demo accounts link to seeded staff; run the seed first (pnpm seed)`
      );
      const inserted = (await db.insert(officers).values({ branchId, name: officerName, active: true, capacityPoints: 30 }).returning({ id: officers.id, branchId: officers.branchId }))[0];
      failUnless(inserted, `demo: officer insert for '${officerName}' returned no row`);
      officerRow = inserted;
    }
    officerIds.set(account.username, officerRow.id);
    // The user row follows its officer's branch, so officer and user always
    // sit in the same branch (Rahul -> IDR, Neha -> DWS, joiner -> UJJAIN).
    branchForUsername.set(account.username, officerRow.branchId);
  }

  const usernames: string[] = [];
  for (const account of DEMO_ACCOUNTS) {
    const officerId = officerIds.get(account.username) ?? null;
    const userBranchId = branchForUsername.get(account.username)!;
    failUnless(userBranchId, `demo: no branch resolved for ${account.username}`);
    await db
      .insert(users)
      .values({ username: account.username, passwordHash, role: account.role, branchId: userBranchId, officerId, active: true, isDemo: true })
      .onConflictDoUpdate({
        target: users.username,
        set: { passwordHash, role: account.role, branchId: userBranchId, officerId, active: true, isDemo: true }
      });
    usernames.push(account.username);
  }

  return { branchId, usernames, officerIdByUsername: Object.fromEntries(officerIds) };
}
