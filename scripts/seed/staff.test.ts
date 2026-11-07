import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng.js';
import { borrowerNamePool, firmName, FIRM_PREFIXES, firmSuffixesFor } from './names.js';
import { BRANCHES, OFFICER_SPECS, MANAGER_SPECS, branchCodeForOfficer } from './staff.js';
import { buildTerritoryRows, territoryOfficerIds, type OfficerNameToId } from './territory.js';
import { realRunStaffIds } from './staffIdsFixture.js';
import { loadSeedConfigFile } from './config.js';
import { fileURLToPath } from 'node:url';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));

describe('borrower and firm name pools (all fictional, A1/A39)', () => {
  it('produces 263 unique borrower names with rng-stable order', () => {
    const rngA = mulberry32(20261105);
    const rngB = mulberry32(20261105);
    const listA = borrowerNamePool(rngA, 263);
    const listB = borrowerNamePool(rngB, 263);
    expect(listA).toHaveLength(263);
    expect(new Set(listA).size).toBe(263);
    expect(listA).toEqual(listB);
    for (const name of listA) {
      expect(name.length).toBeGreaterThan(2);
      expect(/^[A-Za-z ]+$/.test(name)).toBe(true);
    }
  });

  it('firm names combine a prefix with the segment-specific suffix pool', () => {
    expect(Object.keys(firmSuffixesFor('manufacturer')).length).toBeGreaterThanOrEqual(5);
    expect(firmSuffixesFor('trader')).not.toEqual(firmSuffixesFor('manufacturer'));
    expect(FIRM_PREFIXES.length).toBeGreaterThanOrEqual(8);
    const rng = mulberry32(3);
    for (let i = 0; i < 30; i++) {
      const firm = firmName(rng, 'trader');
      expect(firm.endsWith(firmSuffixesFor('trader').find((suffix) => firm.endsWith(suffix))!)).toBe(true);
    }
  });
});

describe('staff specs (SPEC 20.1, A31, prompt-8 people row)', () => {
  it('covers exactly the specified branches and officer counts', () => {
    expect(BRANCHES.map((branch) => branch.name)).toEqual(['Indore', 'Dewas', 'Ujjain']);
    expect(OFFICER_SPECS.filter((officer) => officer.branchCode === 'IDR')).toHaveLength(4);
    expect(OFFICER_SPECS.filter((officer) => officer.branchCode === 'DWS')).toHaveLength(2);
    expect(OFFICER_SPECS.filter((officer) => officer.branchCode === 'UJJAIN')).toHaveLength(3); // 2 Ujjain + 1 Ratlam (A3)
    expect(MANAGER_SPECS).toHaveLength(3);
    expect(OFFICER_SPECS.length).toBe(9);
  });

  it('includes the brief\'s Rahul Chouhan, Neha Solanki and Imran Qureshi, and Ratlam sits on the Ujjain branch', () => {
    const names = OFFICER_SPECS.map((officer) => officer.name);
    expect(names).toContain('Rahul Chouhan');
    expect(names).toContain('Neha Solanki');
    expect(names).toContain('Imran Qureshi');
    const ratlam = OFFICER_SPECS.find((officer) => branchCodeForOfficer(officer) === 'ratlam');
    expect(ratlam).toBeDefined();
    expect(ratlam!.branchCode).toBe('UJJAIN');
    expect(ratlam!.name).toBe('Imran Qureshi');
  });

  it('all usernames are unique, lowercase dotted, and every officer/manager maps to a branch', () => {
    const usernames = [...OFFICER_SPECS, ...MANAGER_SPECS].map((spec) => spec.username);
    expect(new Set(usernames).size).toBe(usernames.length);
    for (const username of usernames) {
      expect(username).toMatch(/^[a-z.]+[a-z]$/);
    }
    expect(branchCodeForOfficer(OFFICER_SPECS[0]!)).toBe('indore');
  });
});

describe('territory rows (SPEC 20.1, prompt-8 territory row, planner-fidelity)', () => {
  const config = loadSeedConfigFile(realFile);
  // The map main.ts builds (the real wiring): StaffIds shaped as the run
  // produces them, rekeyed by territoryOfficerIds. Since step 0.5 the plan
  // references only the 9 staff officers — no demo slices.
  const ids: OfficerNameToId = territoryOfficerIds(realRunStaffIds());

  it('builds 9 rows: Indore 4, Dewas 2, Ujjain city 2 (Freeganj + generic), Ratlam 1 on the Ujjain branch', () => {
    const rows = buildTerritoryRows(config, ids);
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.branchCode === 'IDR')).toHaveLength(4);
    expect(rows.filter((row) => row.branchCode === 'DWS')).toHaveLength(2);
    expect(rows.filter((row) => row.branchCode === 'UJJAIN')).toHaveLength(3);
    const ratlamRow = rows.find((row) => row.pincode === config.territory.ratlam_pincode);
    expect(ratlamRow).toBeDefined();
    expect(ratlamRow!.branchCode).toBe('UJJAIN');
    expect(ratlamRow!.officerName).toBe('Imran Qureshi');
  });

  it('splits shared pincodes by locality and resolves every loan address deterministically', () => {
    const rows = buildTerritoryRows(config, ids);
    const keyCount = new Set(rows.map((row) => `${row.branchCode}|${row.pincode}|${row.locality ?? ''}`)).size;
    expect(keyCount).toBe(9); // unique (branch, pincode, locality) scope
    const dewasRows = rows.filter((row) => row.branchCode === 'DWS');
    for (const locality of config.territory.dewas_localities) {
      expect(dewasRows.find((row) => row.locality === locality)).toBeDefined();
    }
    // Ujjain: Freeganj's exact slice stays with Trupti, the generic row is
    // Arjun's; no demo officers appear in the plan since step 0.5.
    expect(rows.find((entry) => entry.locality === config.territory.ujjain_localities)!.officerName).toBe('Trupti Girdhar');
    expect(rows.find((entry) => entry.branchCode === 'UJJAIN' && entry.locality === null)!.officerName).toBe('Arjun Verma');
    for (const row of rows) {
      expect(row.officerName).not.toMatch(/^Demo Officer/);
    }
    // The defect pincode must fail every prefix tier inside each branch's rows:
    // 466001 shares no 5/4/3-digit prefix with 452xxx, 455xxx, 456xxx or 457xxx.
    for (const pincode of ['452001', '452010', '452016', '455001', '456001', '457001']) {
      for (const length of [5, 4, 3]) {
        const prefix = config.territory.unmapped_defect_pincode.slice(0, length);
        expect(pincode.startsWith(prefix)).toBe(false);
      }
    }
  });
});
