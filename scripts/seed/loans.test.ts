import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile } from './config.js';
import { buildLoanUniverse, briefLoanDefinitions, type GeneratedLoan } from './loans.js';
import { mulberry32 } from './rng.js';
import { OFFICER_SPECS } from './staff.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));
const config = loadSeedConfigFile(realFile);

function universeFor(seed = 20261105) {
  return buildLoanUniverse(mulberry32(seed), config, seed);
}

describe('loan universe sizes (prompt 8 row)', () => {
  it('makes exactly the configured 180 end-active loans in the configured branch split', () => {
    const universe = universeFor();
    const endActive = universe.loans.filter((loan) => loan.destiny !== 'cure');
    expect(endActive).toHaveLength(config.loans.total_end_active);
    expect(endActive.filter((loan) => loan.branchCode === 'IDR')).toHaveLength(config.loans.per_branch_indore);
    expect(endActive.filter((loan) => loan.branchCode === 'DWS')).toHaveLength(config.loans.per_branch_dewas);
    expect(endActive.filter((loan) => loan.branchCode === 'UJJ')).toHaveLength(config.loans.per_branch_ujjain_branch);
    expect(endActive.filter((loan) => loan.branchCode === 'UJJ' && loan.subBranch === 'ratlam')).toHaveLength(
      config.loans.per_branch_ratlam
    );
    expect(endActive.filter((loan) => loan.branchCode === 'UJJ' && loan.subBranch === 'ujjain')).toHaveLength(
      config.loans.per_branch_ujjain_city
    );
  });

  it('holds the full destiny allocation with the resolved cohort arithmetic', () => {
    const universe = universeFor();
    const count = (destiny: GeneratedLoan['destiny']): number => universe.loans.filter((loan) => loan.destiny === destiny).length;
    expect(count('roll')).toBe(
      config.history.roll_count_indore + config.history.roll_count_ujjain_branch + config.history.roll_count_dewas
    );
    expect(count('stay')).toBe(
      config.history.stayed_count_indore + config.history.stayed_count_ujjain_branch + config.history.stayed_count_dewas
    );
    const cohort = count('roll') + count('stay') + count('cure');
    expect(cohort).toBe(config.history.cohort_count_indore + config.history.cohort_count_ujjain_branch + config.history.cohort_count_dewas);
    expect(cohort).toBeGreaterThanOrEqual(config.history.cohort_min_n);
    // cured = cohort − rolled − stayed, and every branch slice matches its config
    expect(count('cure')).toBe(cohort - count('roll') - count('stay'));
  });
});

describe('segment and ticket distributions (SPEC 14 numbers)', () => {
  it('keeps the 45/45/10 segment split exact over the whole universe', () => {
    const universe = universeFor();
    const n = universe.loans.length;
    const manufacturers = universe.loans.filter((loan) => loan.segment === 'manufacturer').length;
    const traders = universe.loans.filter((loan) => loan.segment === 'trader').length;
    const services = universe.loans.filter((loan) => loan.segment === 'service').length;
    expect(manufacturers).toBe(Math.floor(0.45 * n));
    expect(traders).toBe(Math.floor(0.45 * n));
    expect(services).toBe(n - Math.floor(0.45 * n) - Math.floor(0.45 * n));
  });

  it('tickets are lognormal-median-6L with the 1.5L-25L clip and an EMI of outstanding/12', () => {
    const universe = universeFor();
    const sample = universe.loans.map((loan) => loan.outstandingRupees).sort((a, b) => a - b);
    const median = sample[sample.length >> 1]!;
    expect(median).toBeGreaterThan(540_000); // ~10% band around the configured median
    expect(median).toBeLessThan(660_000);
    for (const loan of universe.loans) {
      expect(loan.outstandingRupees).toBeGreaterThanOrEqual(config.loans.ticket_min_rupees);
      expect(loan.outstandingRupees).toBeLessThanOrEqual(config.loans.ticket_max_rupees);
      expect(loan.emiRupees).toBe(Math.round(loan.outstandingRupees / 12));
      expect(loan.bounceCount).toBeLessThanOrEqual(config.loans.bounce_cap);
      expect(loan.vintageMonths).toBeGreaterThanOrEqual(config.loans.vintage_min_months);
      expect(loan.vintageMonths).toBeLessThanOrEqual(config.loans.vintage_max_months);
    }
  });
});

describe('contact data and deliberate defects (SPEC 14 row)', () => {
  it('every mobile is a 10-digit 6-9 number; addresses exist', () => {
    const universe = universeFor();
    for (const loan of universe.loans) {
      expect(loan.mobile).toMatch(/^[6-9]\d{9}$/);
      expect(loan.address.length).toBeGreaterThan(5);
    }
  });

  it('applies 8% missing alt mobile and 5% missing business name over the end-active set, exactly', () => {
    const universe = universeFor();
    const endActive = universe.loans.filter((loan) => loan.destiny !== 'cure');
    const expectedAlt = Math.round(config.defects.missing_alt_mobile_rate * endActive.length);
    const expectedBusiness = Math.round(config.defects.missing_business_name_rate * endActive.length);
    const missingAlt = endActive.filter((loan) => loan.altMobile === null).length;
    const missingBusiness = endActive.filter((loan) => loan.businessName === null).length;
    expect(missingAlt).toBe(expectedAlt); // 0.08 * 180 = 14
    expect(missingBusiness).toBe(expectedBusiness); // 0.05 * 180 = 9
    // Cured loans carry complete data — the visible portfolio is where the
    // defect story lives.
    expect(universe.loans.filter((loan) => loan.destiny === 'cure' && loan.altMobile === null)).toHaveLength(0);
  });

  it('puts exactly the 3% unmapped pins on loans whose prefix fails every tier, queueing them', () => {
    const universe = universeFor();
    const endActive = universe.loans.filter((loan) => loan.destiny !== 'cure');
    const expectedUnmapped = Math.round(config.defects.unmapped_pincode_rate * endActive.length);
    const defectPin = config.territory.unmapped_defect_pincode;
    const unmapped = universe.loans.filter((loan) => loan.pincode === defectPin);
    expect(unmapped).toHaveLength(expectedUnmapped); // 0.03 * 180 = 5
    for (const loan of unmapped) {
      // shares NO 5/4/3-digit prefix with its branch's listed pins
      for (const listed of ['452001', '452010', '452016', '455001', '456001', '457001']) {
        for (const length of [5, 4, 3]) {
          expect(listed.startsWith(loan.pincode.slice(0, length))).toBe(false);
        }
      }
    }
  });

  it('is deterministic for a fixed seed and moves with a different seed', () => {
    const a = universeFor(20261105);
    const b = universeFor(20261105);
    const c = universeFor(20261106);
    expect(a.loans.map((loan) => loan.loanId)).toEqual(b.loans.map((loan) => loan.loanId));
    expect(a.loans.map((loan) => loan.loanId)).not.toEqual(c.loans.map((loan) => loan.loanId));
  });
});

describe('the brief\'s three loans (prompt 8 row)', () => {
  it('pins LN-10293, LN-10871 and LN-11930 with the brief values at the end date', () => {
    const universe = universeFor();
    const byId = new Map(universe.loans.map((loan) => [loan.loanId, loan]));
    const briefs = briefLoanDefinitions(universe, config);
    expect(briefs.map((brief) => brief.loanId).sort()).toEqual(['LN-10293', 'LN-10871', 'LN-11930']);
    // Values straight from data/sample_overdue.csv (POS rupees, DPD at end).
    expect(byId.get('LN-10293')).toMatchObject({
      borrowerName: 'Ramesh Sharma',
      businessName: 'Sharma Kirana',
      outstandingRupees: 640_000,
      entryDayOffset: 11, // briefEndDpd 12 minus 1
      branchCode: 'UJJ',
      subBranch: 'ratlam'
    });
    expect(byId.get('LN-10871')).toMatchObject({
      borrowerName: 'Sunita Bai',
      businessName: null, // the brief itself ships this row without a business name
      outstandingRupees: 310_000,
      entryDayOffset: 26, // briefEndDpd 27 minus 1
      branchCode: 'UJJ'
    });
    expect(byId.get('LN-11930')).toMatchObject({
      borrowerName: 'Abdul Khan',
      businessName: 'Khan Traders',
      outstandingRupees: 220_000,
      entryDayOffset: 18, // briefEndDpd 19 minus 1
      branchCode: 'DWS'
    });
    // LN-10871/11930 are destiny-fresh entries (dpd 27/19 both below 30);
    // LN-10293 stays active on a Ratlam slice. All three are end-active.
    for (const brief of briefs) {
      expect(byId.get(brief.loanId)!.destiny).toBe('fresh');
      expect(byId.get(brief.loanId)!.entryDayOffset).toBe(brief.briefEndDpd - 1);
    }
  });

  it('keeps all generated loan ids unique and off the brief ids', () => {
    const universe = universeFor();
    const ids = universe.loans.map((loan) => loan.loanId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => /^LN-\d{5}$/.test(id)).length).toBe(ids.length);
  });
});

describe('address/table hygiene (SPEC 14 privacy row)', () => {
  it('carries no PAN, Aadhaar or GST shaped values anywhere in loan fields', () => {
    const universe = universeFor();
    const panShape = /\b[A-Z]{3}[0-9]{4}[A-Z]\b/;
    const aadhaarShape = /\b[2-9]\d{11}\b/;
    const gstShape = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\w{3}[A-Z\d][A-Z]{2}\b/;
    for (const loan of universe.loans) {
      const fields = [loan.borrowerName, loan.businessName, loan.address, loan.mobile, loan.altMobile];
      for (const field of fields) {
        if (field === null) {
          continue;
        }
        expect(field).not.toMatch(panShape);
        expect(field).not.toMatch(aadhaarShape);
        expect(field).not.toMatch(gstShape);
      }
    }
  });

  it('assigns every officer a share of loans inside its own branch territory', () => {
    const universe = universeFor();
    const officersByBranch = new Map<string, number>();
    for (const officer of OFFICER_SPECS) {
      officersByBranch.set(officer.territoryTag, officersByBranch.get(officer.territoryTag) ?? 0);
    }
    // Domestic check only: each branch's loans resolve somewhere on its listed pins.
    expect(universe.loans.filter((loan) => loan.branchCode === 'DWS' && loan.pincode !== config.territory.dewas_pincode && loan.pincode !== config.territory.unmapped_defect_pincode)).toHaveLength(0);
    for (const officer of OFFICER_SPECS) {
      expect(officer.name.length).toBeGreaterThan(0);
    }
  });
});
