/**
 * Seeded people (prompt 8): three branches (SPEC 20.1), nine fictional field
 * officers (4 Indore, 2 Dewas, 2 Ujjain + the Ratlam officer who belongs to
 * the Ujjain branch, A3) and three fictional branch managers. The officer
 * names Rahul Chouhan, Neha Solanki and Imran Qureshi come from the brief's
 * sample rows. Every login uses the documented demo PIN hashed with the
 * project scrypt (A31) and is_demo=true, so DEMO_MODE gates them all.
 *
 * Personnel data is FICTIONAL (A1): no real person exists behind any name.
 */
import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { hashPassword } from '../../src/server/auth.js';
import { branches, officers, users } from '../../src/server/db/schema.js';
import { DEMO_PIN, ensureDemoAccounts } from '../../src/server/demo.js';

export interface BranchSpec {
  code: string;
  name: string;
}

export const BRANCHES: readonly BranchSpec[] = [
  { code: 'IDR', name: 'Indore' },
  { code: 'DWS', name: 'Dewas' },
  // A31: the Ujjain branch row IS the demo branch (code UJJAIN, name
  // 'Ujjain') — one row, so the importer's name->id map stays unambiguous.
  { code: 'UJJAIN', name: 'Ujjain' }
];

export interface OfficerSpec {
  name: string;
  username: string;
  branchCode: string;
  /** 'ratlam' marks the Ujjain-branch officer serving Ratlam (A3). */
  territoryTag: 'indore' | 'dewas' | 'ujjain' | 'ratlam';
}

export const OFFICER_SPECS: readonly OfficerSpec[] = [
  { name: 'Rahul Chouhan', username: 'rahul.chouhan', branchCode: 'IDR', territoryTag: 'indore' },
  { name: 'Savitri Bhil', username: 'savitri.bhil', branchCode: 'IDR', territoryTag: 'indore' },
  { name: 'Premnarayan Bhaskar', username: 'premnarayan.bhaskar', branchCode: 'IDR', territoryTag: 'indore' },
  { name: 'Shailja Yadav', username: 'shailja.yadav', branchCode: 'IDR', territoryTag: 'indore' },
  { name: 'Neha Solanki', username: 'neha.solanki', branchCode: 'DWS', territoryTag: 'dewas' },
  { name: 'Murlidhar Garg', username: 'murlidhar.garg', branchCode: 'DWS', territoryTag: 'dewas' },
  { name: 'Arjun Verma', username: 'arjun.verma', branchCode: 'UJJAIN', territoryTag: 'ujjain' },
  { name: 'Trupti Girdhar', username: 'trupti.girdhar', branchCode: 'UJJAIN', territoryTag: 'ujjain' },
  { name: 'Imran Qureshi', username: 'imran.qureshi', branchCode: 'UJJAIN', territoryTag: 'ratlam' }
];

export interface ManagerSpec {
  name: string;
  username: string;
  branchCode: string;
}

export const MANAGER_SPECS: readonly ManagerSpec[] = [
  { name: 'Kavita Rathore', username: 'kavita.rathore', branchCode: 'IDR' },
  { name: 'Suresh Malviya', username: 'suresh.malviya', branchCode: 'DWS' },
  { name: 'Pankaj Trivedi', username: 'pankaj.trivedi', branchCode: 'UJJAIN' }
];

export function branchCodeForOfficer(officer: OfficerSpec): OfficerSpec['territoryTag'] {
  return officer.territoryTag;
}

export interface StaffIds {
  branchIdByCode: Record<string, string>;
  officerIdByName: Record<string, string>;
  userIdByUsername: Record<string, string>;
  demoUsernames: string[];
  /** The demo officers' own ids (A50), keyed by USERNAME exactly as
   *  ensureDemoAccounts returns them: territory slices are written for them
   *  too, so the demo worklist is never empty after a seed — territory.ts
   *  rekeys these to officer names (territoryOfficerIds). */
  demoOfficerIdByUsername: Record<string, string>;
}

/** Idempotent staff upsert: branches on code, officers by name lookup, users
 *  on username. The demo-pin users are flipped active and is_demo every run
 *  so a partially disabled database puts itself right during a reseed. */
export async function upsertStaff(db: NeonHttpDatabase, capacityPoints: number): Promise<StaffIds> {
  const branchIdByCode: Record<string, string> = {};
  for (const branch of BRANCHES) {
    const rows = await db
      .insert(branches)
      .values({ code: branch.code, name: branch.name })
      .onConflictDoUpdate({ target: branches.code, set: { name: branch.name } })
      .returning({ id: branches.id });
    const row = rows[0];
    if (!row) {
      throw new Error(`seed people: branch ${branch.code} insert returned no row`);
    }
    branchIdByCode[branch.code] = row.id;
  }

  const passwordHash = hashPassword(DEMO_PIN);

  const officerIdByName: Record<string, string> = {};
  for (const spec of OFFICER_SPECS) {
    const branchId = branchIdByCode[spec.branchCode];
    if (!branchId) {
      throw new Error(`seed people: branch ${spec.branchCode} missing for officer ${spec.name}`);
    }
    const existing = (
      await db.select({ id: officers.id }).from(officers).where(eq(officers.name, spec.name)).limit(1)
    )[0];
    const officerId = existing
      ? existing.id
      : (
        await db
          .insert(officers)
          .values({ branchId, name: spec.name, active: true, capacityPoints, buddyOfficerId: null })
          .returning({ id: officers.id })
      )[0]?.id;
    if (!officerId) {
      throw new Error(`seed people: officer ${spec.name} write produced no id`);
    }
    officerIdByName[spec.name] = officerId;
    await db
      .insert(users)
      .values({ username: spec.username, passwordHash, role: 'field_officer', branchId, officerId, active: true, isDemo: true })
      .onConflictDoUpdate({
        target: users.username,
        set: { passwordHash, role: 'field_officer', branchId, officerId, active: true, isDemo: true }
      });
  }

  const userIdByUsername: Record<string, string> = {};
  for (const spec of MANAGER_SPECS) {
    const branchId = branchIdByCode[spec.branchCode];
    if (!branchId) {
      throw new Error(`seed people: branch ${spec.branchCode} missing for manager ${spec.name}`);
    }
    const rows = await db
      .insert(users)
      .values({ username: spec.username, passwordHash, role: 'branch_manager', branchId, officerId: null, active: true, isDemo: true })
      .onConflictDoUpdate({
        target: users.username,
        set: { passwordHash, role: 'branch_manager', branchId, officerId: null, active: true, isDemo: true }
      })
      .returning({ id: users.id });
    const row = rows[0];
    if (!row) {
      throw new Error(`seed people: manager ${spec.username} write produced no id`);
    }
    userIdByUsername[spec.username] = row.id;
  }

  // SPEC 16 / A31 demo chips ride on the same run: ensureDemoAccounts is
  // idempotent and only touches its own branch code UJJAIN + its trio.
  const demo = await ensureDemoAccounts(db, 'UJJAIN');
  const demoUsernames = demo.usernames;

  return {
    branchIdByCode,
    officerIdByName,
    userIdByUsername,
    demoUsernames,
    demoOfficerIdByUsername: demo.officerIdByUsername
  };
}
