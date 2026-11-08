/**
 * Bilingual reason phrases for the scorecard's top-3 contributions (SPEC 8):
 * each feature maps to a templated line carrying its evidence —
 * "1 broken promise in 90 days", "No contact for 9 days". The templates are
 * the ONLY place the feature names become human language, so the client
 * never re-derives them.
 */
import type { ReasonContribution } from './scorecard.js';

/** The UI language — structurally the client's Lang, declared locally so
 *  shared never imports client code. */
export type ReasonLang = 'hi' | 'en';

type PhraseFn = (evidence: Record<string, number | string>) => string;

const EN: Record<string, PhraseFn> = {
  broken90: (e) => `${e.count} broken promise${Number(e.count) === 1 ? '' : 's'} in 90 days`,
  bounces: (e) => `${e.count} bounced payment${Number(e.count) === 1 ? '' : 's'} in 12 months`,
  daysSinceContact: (e) => `No contact for ${e.days} days`,
  dpd: (e) => `${e.days} days past due`,
  overdueEmiMultiples: (e) => `Overdue is ${e.multiples} EMIs`,
  lastOutcomeGroup: (e) => {
    switch (String(e.group)) {
      case 'unreachable':
        return 'Last contact could not reach the borrower';
      case 'refused':
        return 'Borrower refused at last contact';
      case 'promised':
        return 'Borrower promised to pay at last contact';
      case 'part_paid':
        return 'Borrower part-paid at last contact';
      default:
        return 'Last contact outcome';
    }
  },
  keptRate: (e) => `${e.kept} of ${e.made} promises kept`,
  logOutstanding: () => 'Outstanding balance is high',
  vintageMonths: (e) => `Young loan relationship (${e.months} months)`
};

const HI: Record<string, PhraseFn> = {
  broken90: (e) => `90 दिनों में ${e.count} टूटा वादा`,
  bounces: (e) => `12 महीनों में ${e.count} बाउंस भुगतान`,
  daysSinceContact: (e) => `${e.days} दिन से कोई संपर्क नहीं`,
  dpd: (e) => `${e.days} दिन अतीत देय`,
  overdueEmiMultiples: (e) => `बकाया ${e.multiples} किश्तें है`,
  lastOutcomeGroup: (e) => {
    switch (String(e.group)) {
      case 'unreachable':
        return 'आख़िरी संपर्क पर उधारकर्ता तक नहीं पहुँचे';
      case 'refused':
        return 'आख़िरी संपर्क पर उधारकर्ता ने मना किया';
      case 'promised':
        return 'आख़िरी संपर्क पर उधारकर्ता ने भुगतान का वादा किया';
      case 'part_paid':
        return 'आख़िरी संपर्क पर उधारकर्ता ने अंशतः भुगतान किया';
      default:
        return 'आख़िरी संपर्क का परिणाम';
    }
  },
  keptRate: (e) => `${e.made} में से ${e.kept} वादे निभाए`,
  logOutstanding: () => 'बकाया राशि अधिक है',
  vintageMonths: (e) => `नया ऋण संबंध (${e.months} महीने)`
};

/** One templated phrase for a reason. Falls back to the English line when a
 *  feature has no template (must not happen — the phrase table is tested
 *  against the weights' feature order). */
export function describeReason(lang: ReasonLang, reason: ReasonContribution): string {
  const table = lang === 'hi' ? HI : EN;
  const template = table[reason.feature];
  if (!template) {
    return reason.feature;
  }
  return template(reason.evidence);
}

export function describeReasons(lang: ReasonLang, reasons: readonly ReasonContribution[]): string[] {
  return reasons.map((reason) => describeReason(lang, reason));
}

const EVIDENCE_EN: Record<string, PhraseFn> = {
  broken90: () => 'in the last 90 days',
  bounces: (e) => `${e.count} in the last 12 months`,
  daysSinceContact: (e) => `${e.days} days since the last attempt`,
  dpd: (e) => `${e.days} days past due at scoring`,
  overdueEmiMultiples: (e) => `${e.multiples} EMIs of overdue`,
  lastOutcomeGroup: (e) => `${String(e.group).replace('_', ' ')}`,
  keptRate: (e) => `${e.kept} of ${e.made} promises settled`,
  logOutstanding: () => 'balance at scoring',
  vintageMonths: (e) => `${e.months} months since disbursal`
};

const EVIDENCE_HI: Record<string, PhraseFn> = {
  broken90: () => 'पिछले 90 दिनों में',
  bounces: (e) => `पिछले 12 महीनों में ${e.count}`,
  daysSinceContact: (e) => `${e.days} दिन पहले अंतिम प्रयास`,
  dpd: (e) => `स्कोरिंग पर ${e.days} दिन अतीत देय`,
  overdueEmiMultiples: (e) => `${e.multiples} किश्त के बराबर बकाया`,
  lastOutcomeGroup: (e) => `${String(e.group).replace('_', ' ')}`,
  keptRate: (e) => `${e.made} में ${e.kept} वादे निभाए`,
  logOutstanding: () => 'स्कोरिंग पर बकाया',
  vintageMonths: (e) => `${e.months} महीने`
};

/** The raw evidence under a reason line (14px secondary in the UI). */
export function describeEvidence(lang: ReasonLang, reason: ReasonContribution): string {
  const table = lang === 'hi' ? EVIDENCE_HI : EVIDENCE_EN;
  const template = table[reason.feature];
  return template ? template(reason.evidence) : '';
}
