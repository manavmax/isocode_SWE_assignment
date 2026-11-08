/**
 * Offline detail fallback (prompt 19.1): when the loan-detail API fails
 * offline, the screen hydrates from the Dexie caches. The fallback chain
 * is pure so it is unit-tested without a database:
 *
 *   1. the full cached LoanDetailDto (fetch succeeded earlier, stored in
 *      the `loans` table) — render as-is;
 *   2. the cached worklist AssignmentCard (the `assignments` table) —
 *      build a partial detail from the card; fields the worklist does not
 *      carry are null and the UI marks them unavailable;
 *   3. neither — the caller renders the error state (the honest outcome).
 *
 * The partial detail keeps the floating action bar rendered so the officer
 * can still queue an outcome offline (SPEC 6: the outbox write precedes
 * everything).
 */
import type { AssignmentCard, LoanDetailDto, ReasonContributionDto } from '../api.js';

export interface FallbackResult {
  detail: LoanDetailDto;
  /** 'cache' = the full detail from the loans table; 'partial' = rebuilt
   *  from the worklist card (facts not cached render unavailable). */
  source: 'cache' | 'partial';
}

function reasonsFromCard(card: AssignmentCard): ReasonContributionDto[] | null {
  return card.topReasons ?? null;
}

/** Build the offline detail from a worklist card. Fields the worklist does
 *  not carry (address, product, EMI, alt phone, status detail) are null —
 *  the UI renders them as '—'. The hero fields (name, business, overdue,
 *  DPD/bucket, phone mask, score) come from the card. */
export function partialDetailFromCard(card: AssignmentCard): FallbackResult {
  return {
    source: 'partial',
    detail: {
      loanId: card.loanId,
      borrowerName: card.borrowerName,
      businessName: card.businessName,
      address: null,
      pincode: card.pincode,
      locality: card.locality,
      product: null,
      outstanding: card.outstanding,
      overdueAmount: card.overdueAmount,
      emiAmount: null,
      dpd: card.dpd,
      bucket: card.bucket,
      assignedOfficerId: null,
      homeOfficerId: null,
      status: 'overdue',
      mobileMasked: card.mobileMasked,
      altMobileMasked: null,
      lastContactDays: null,
      openPromiseDue: card.duePromise ? 'today' : null,
      score: card.score,
      band: card.band,
      rupeesAtRisk: card.rupeesAtRisk,
      limitedData: true,
      topReasons: reasonsFromCard(card)
    }
  };
}

/** The fallback chain. Returns null when neither cache has the loan. */
export function loanOfflineFallback(
  loanId: string,
  cachedDetail: LoanDetailDto | undefined,
  worklistCard: AssignmentCard | undefined
): FallbackResult | null {
  if (cachedDetail && cachedDetail.loanId === loanId) {
    return { detail: cachedDetail, source: 'cache' };
  }
  if (worklistCard && worklistCard.loanId === loanId) {
    return partialDetailFromCard(worklistCard);
  }
  return null;
}
