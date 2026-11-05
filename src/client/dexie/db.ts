import Dexie, { type Table } from 'dexie';
import type { AssignmentCard } from '../api.js';

/** Offline cache of the officer's assignment list (SPEC 4/16): one online
 * load makes the Today list render offline; expires after 24 h; wiped on
 * logout. fetchedAt is the read stamp shown as "Last updated hh:mm". */
export interface CachedAssignments {
  key: 'assignments';
  loans: AssignmentCard[];
  fetchedAt: number;
}

class CollectionsDb extends Dexie {
  assignments!: Table<CachedAssignments, string>;

  constructor() {
    super('field-collections');
    this.version(1).stores({
      assignments: 'key'
    });
  }
}

export const db = new CollectionsDb();

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function saveAssignments(loans: AssignmentCard[], fetchedAt = Date.now()): Promise<void> {
  await db.assignments.put({ key: 'assignments', loans, fetchedAt });
}

export async function loadAssignments(): Promise<CachedAssignments | undefined> {
  const cached = await db.assignments.get('assignments');
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    await db.assignments.delete('assignments');
    return undefined;
  }
  return cached;
}

export async function clearCache(): Promise<void> {
  await db.assignments.clear();
}
