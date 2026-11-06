/**
 * Live counts from the outbox for the sync pill and the Sync section.
 * Dexie liveQuery re-emits whenever the outbox tables change, so the UI
 * updates on every state transition without a polling loop.
 */
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { getOutboxCounts } from '../dexie/db.js';

export interface OutboxCounts {
  pending: number;
  failed: number;
  synced: number;
}

export function useOutboxCounts(): OutboxCounts {
  const [counts, setCounts] = useState<OutboxCounts>({ pending: 0, failed: 0, synced: 0 });

  useEffect(() => {
    try {
      const sub = liveQuery(() => getOutboxCounts()).subscribe({
        next: (c) => {
          if (c) setCounts(c);
        },
        error: () => {
          /* Dexie unavailable: keep zeros */
        }
      });
      return () => sub.unsubscribe();
    } catch {
      return undefined;
    }
  }, []);

  return counts;
}
