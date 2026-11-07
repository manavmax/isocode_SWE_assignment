/**
 * The Promises nav badge (prompt 11 item 5): the due-today count from the
 * cached promise sections, re-emitted by a Dexie liveQuery whenever the
 * cache row changes (the Promises screen refreshes it on entry, so the
 * badge follows within one navigation without its own fetch loop).
 */
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { loadPromises } from '../dexie/db.js';

export function useDueTodayCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    try {
      const sub = liveQuery(async () => {
        const cached = await loadPromises();
        return cached?.sections.dueToday.length ?? 0;
      }).subscribe({
        next: (n) => {
          if (typeof n === 'number') setCount(n);
        },
        error: () => {
          /* Dexie unavailable: keep zero */
        }
      });
      return () => sub.unsubscribe();
    } catch {
      return undefined;
    }
  }, []);

  return count;
}
