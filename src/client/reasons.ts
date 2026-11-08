/**
 * Reason display filtering (prompt 20 item 11): the screens that show the
 * score reasons already render the days-overdue fact ("N days overdue" /
 * "N दिन अतीत देय") in the card row or the facts list. The scorecard's dpd
 * reason would repeat the same fact as "N days past due" directly under
 * it, so it is dropped from the rendered list everywhere.
 */
import type { ReasonContributionDto } from './api.js';

export function visibleReasons(
  reasons: readonly ReasonContributionDto[] | null | undefined
): ReasonContributionDto[] {
  return (reasons ?? []).filter((reason) => reason.feature !== 'dpd');
}
