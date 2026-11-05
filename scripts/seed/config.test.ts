import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSeedConfigFile, parseSeedConfig, parseSeedStructure } from './config.js';

const realFile = fileURLToPath(new URL('../../data/seed_config.yaml', import.meta.url));

describe('parseSeedStructure (strict subset of YAML)', () => {
  it('parses sections, scalars and inline lists', () => {
    const parsed = parseSeedStructure(
      [
        '# a comment line',
        'people:',
        '  officer_count_indore: 4',
        '  demo_pin: "1234"',
        'loans:',
        '  segment_weights: "0.45,0.45,0.10"',
        ''
      ].join('\n'),
      '/virtual/seed_config.yaml'
    );
    expect(parsed.people!.officer_count_indore).toBe('4');
    expect(parsed.people!.demo_pin).toBe('1234');
    expect(parsed.loans!.segment_weights).toEqual(['0.45', '0.45', '0.10']);
  });

  it('rejects nesting deeper than one level and duplicate keys, allows flat entries', () => {
    expect(() => parseSeedStructure('a:\n  b:\n    c: 1\n', '/v')).toThrow(/nesting/);
    expect(() => parseSeedStructure('a:\n  b: 1\n  b: 2\n', '/v')).toThrow(/duplicate/);
    expect(() => parseSeedStructure('flat: 1\n', '/v')).not.toThrow(); // top-level scalars parse fine
  });
});

describe('parseSeedConfig', () => {
  it('loads the real file through the same path loadSeedConfigFile uses', () => {
    const config = parseSeedConfig(readFileSync(realFile, 'utf8'));
    expect(config.people.officer_count_indore).toBe(4);
  });

  it('throws naming the missing key when a required entry is absent', () => {
    const text = 'people:\n  officer_count_indore: 4\n';
    expect(() => parseSeedConfig(text, '/virtual/seed_config.yaml')).toThrow(/seed\.run_date is missing/);
  });

  it('rejects unknown extra sections instead of ignoring rates silently', () => {
    const raw = `${readFileSync(realFile, 'utf8')}generator:\n  extra: 1\n`;
    expect(() => parseSeedConfig(raw, '/virtual/seed_config.yaml')).toThrow(/unexpected section generator/);
  });

  it('confirms the penalty counts sit in the calibrated band and sum correctly', () => {
    const config = loadSeedConfigFile(realFile);
    const num = (key: string): number => {
      const value = (config.history as unknown as Record<string, number | undefined>)[key];
      if (typeof value !== 'number') {
        throw new Error(`${key} must be a number, got ${String(value)}`);
      }
      return value;
    };
    for (const branch of ['indore', 'ujjain_branch', 'dewas'] as const) {
      const cohort = num(`cohort_count_${branch}`);
      const roll = num(`roll_count_${branch}`);
      const stayed = num(`stayed_count_${branch}`);
      const early = num(`early_count_${branch}`);
      expect(roll / cohort).toBeGreaterThanOrEqual(0.19);
      expect(roll / cohort).toBeLessThanOrEqual(0.25);
      expect(roll + stayed).toBeLessThanOrEqual(cohort);
      expect(roll + stayed + early).toBeLessThanOrEqual(
        branch === 'indore' ? config.loans.per_branch_indore : branch === 'dewas' ? config.loans.per_branch_dewas : config.loans.per_branch_ujjain_branch
      );
    }
  });

  it('loads and validates the real data/seed_config.yaml', () => {
    const config = loadSeedConfigFile(realFile);
    expect(config.people.officer_count_indore).toBe(4);
    expect(config.people.officer_count_dewas).toBe(2);
    expect(config.people.officer_count_ujjain).toBe(2);
    expect(config.people.officer_count_ratlam).toBe(1);
    expect(config.people.manager_count).toBe(3);
    expect(config.people.officer_capacity_points).toBe(50);
    expect(config.loans.total_end_active).toBe(180);
    expect(config.loans.per_branch_indore).toBe(90);
    expect(config.loans.per_branch_ujjain_branch).toBe(55);
    expect(config.loans.per_branch_ujjain_city).toBe(35);
    expect(config.loans.per_branch_ratlam).toBe(20);
    expect(config.loans.per_branch_dewas).toBe(35);
  });

  it('keeps every rate inside its recorded bounds', () => {
    const config = loadSeedConfigFile(realFile);
    const [w1, w2, w3] = config.loans.segment_weights;
    expect(w1! + w2! + w3!).toBeCloseTo(1, 9);
    expect(config.loans.ticket_min_rupees).toBeLessThan(config.loans.ticket_median_rupees);
    expect(config.loans.ticket_median_rupees).toBeLessThan(config.loans.ticket_max_rupees);
    expect(config.history.cohort_min_n).toBeGreaterThanOrEqual(100);
    for (const roll of [
      config.history.roll_count_indore,
      config.history.roll_count_ujjain_branch,
      config.history.roll_count_dewas
    ] as number[]) {
      expect(roll).toBeGreaterThan(0);
    }
    expect(config.defects.missing_alt_mobile_rate).toBeGreaterThan(0);
    expect(config.defects.missing_business_name_rate).toBeGreaterThan(0);
    expect(config.defects.unmapped_pincode_rate).toBeGreaterThan(0);
  });

  it('throws naming the missing key when a required entry is absent', () => {
    const text = 'people:\n  officer_count_indore: 4\n';
    expect(() => parseSeedConfig(text, '/virtual/seed_config.yaml')).toThrow(/seed\.run_date is missing/);
  });

  it('rejects a branch roll rate outside the 19-25% calibration band', () => {
    // 15/80 = 18.75% breaks the branch band while the overall roll rate stays
    // inside the ±2pp target band.
    const raw = readFileSync(realFile, 'utf8').replace('cohort_count_indore: 68', 'cohort_count_indore: 80');
    expect(() => parseSeedConfig(raw, '/virtual/seed_config.yaml')).toThrow(/0\.19 and 0\.25|roll rate/);
  });

  it('rejects roll counts that drift the overall rate away from the configured target', () => {
    const raw = readFileSync(realFile, 'utf8').replace('roll_count_indore: 15', 'roll_count_indore: 24');
    expect(() => parseSeedConfig(raw, '/virtual/seed_config.yaml')).toThrow(/configured target/);
  });

  it('keeps the resolved cohort above the configured minimum', () => {
    const raw = readFileSync(realFile, 'utf8').replace('cohort_count_indore: 68', 'cohort_count_indore: 10');
    expect(() => parseSeedConfig(raw, '/virtual/seed_config.yaml')).toThrow(/cohort n resolves to/);
  });
});

