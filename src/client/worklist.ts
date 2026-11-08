/**
 * Today worklist display grouping (prompt 20 item 3). The server owns the
 * order (SPEC 8); this module derives the DISPLAY lane from the rendered
 * order:
 *
 *  - a promise-due loan is never styled low-lane, even when its score flag
 *    says low — the pin IS the priority signal;
 *  - the LOW PRIORITY divider renders once, immediately above the first
 *    low-lane card that follows a non-low card — a list that opens with
 *    low cards (e.g. a manager-pinned low-score loan) gets no divider.
 */
import type { AssignmentCard } from './api.js';

export interface WorklistCard {
  loan: AssignmentCard;
  lowLane: boolean;
}

export interface WorklistView {
  cards: WorklistCard[];
  /** Index into cards where the divider renders (null = no divider). */
  dividerIndex: number | null;
}

export function groupWorklist(loans: readonly AssignmentCard[]): WorklistView {
  const cards = loans.map((loan) => ({
    loan,
    lowLane: loan.lowLane === true && loan.duePromise !== true
  }));
  const divider = cards.findIndex(
    (card, index) => card.lowLane && index > 0 && !cards[index - 1]!.lowLane
  );
  return { cards, dividerIndex: divider === -1 ? null : divider };
}
