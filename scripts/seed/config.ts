/**
 * seed_config.yaml loader (SPEC 14 / A35). The file uses a strict subset of
 * YAML chosen on purpose (A34): # comments, one level of `section:` nesting,
 * `key: value` scalars, comma-separated inline lists. A purpose-built ~70
 * line parser replaces a YAML dependency (SPEC 18: dependencies need a
 * reason; only this controlled shape is needed and every failure exits
 * before any database write).
 */
import { readFileSync } from 'node:fs';

export interface SeedConfig {
  seed: {
    run_date: string;
    require_yes_flag: boolean;
    require_demo_mode: boolean;
    reset_tables: string[];
  };
  people: {
    officer_count_indore: number;
    officer_count_dewas: number;
    officer_count_ujjain: number;
    officer_count_ratlam: number;
    manager_count: number;
    officer_capacity_points: number;
    demo_pin: string;
  };
  territory: {
    indore_pincode_main: string;
    indore_pincode_east: string;
    indore_pincode_south: string;
    indore_shared_locality: string;
    dewas_pincode: string;
    dewas_localities: string[];
    ujjain_pincode: string;
    ujjain_localities: string[];
    ratlam_pincode: string;
    unmapped_defect_pincode: string;
  };
  loans: {
    total_end_active: number;
    per_branch_indore: number;
    per_branch_ujjain_branch: number;
    per_branch_ujjain_city: number;
    per_branch_ratlam: number;
    per_branch_dewas: number;
    segment_weights: number[];
    ticket_median_rupees: number;
    ticket_ln_sigma: number;
    ticket_min_rupees: number;
    ticket_max_rupees: number;
    bounce_poisson_lambda: number;
    bounce_cap: number;
    vintage_min_months: number;
    vintage_max_months: number;
    product_manufacturer: string;
    product_trader: string;
    product_service: string;
  };
  history: {
    window_days: number;
    cohort_days_before_end: number;
    skip_sundays: number;
    cohort_min_n: number;
    roll_target: string;
    cohort_count_indore: number;
    cohort_count_ujjain_branch: number;
    cohort_count_dewas: number;
    roll_count_indore: number;
    roll_count_ujjain_branch: number;
    roll_count_dewas: number;
    stayed_count_indore: number;
    stayed_count_ujjain_branch: number;
    stayed_count_dewas: number;
    early_count_indore: number;
    early_count_ujjain_branch: number;
    early_count_dewas: number;
    max_cures_per_day: number;
    reentry_wait_min_days: number;
    reentry_wait_max_days: number;
  };
  defects: {
    missing_alt_mobile_rate: number;
    missing_business_name_rate: number;
    unmapped_pincode_rate: number;
  };
}

const EXPECTED_KEYS: Record<string, Record<string, 'scalar' | 'list'>> = {
  seed: { run_date: 'scalar', require_yes_flag: 'scalar', require_demo_mode: 'scalar', reset_tables: 'list' },
  people: {
    officer_count_indore: 'scalar',
    officer_count_dewas: 'scalar',
    officer_count_ujjain: 'scalar',
    officer_count_ratlam: 'scalar',
    manager_count: 'scalar',
    officer_capacity_points: 'scalar',
    demo_pin: 'scalar'
  },
  territory: {
    indore_pincode_main: 'scalar',
    indore_pincode_east: 'scalar',
    indore_pincode_south: 'scalar',
    indore_shared_locality: 'scalar',
    dewas_pincode: 'scalar',
    dewas_localities: 'list',
    ujjain_pincode: 'scalar',
    ujjain_localities: 'list',
    ratlam_pincode: 'scalar',
    unmapped_defect_pincode: 'scalar'
  },
  loans: {
    total_end_active: 'scalar',
    per_branch_indore: 'scalar',
    per_branch_ujjain_branch: 'scalar',
    per_branch_ujjain_city: 'scalar',
    per_branch_ratlam: 'scalar',
    per_branch_dewas: 'scalar',
    segment_weights: 'list',
    ticket_median_rupees: 'scalar',
    ticket_ln_sigma: 'scalar',
    ticket_min_rupees: 'scalar',
    ticket_max_rupees: 'scalar',
    bounce_poisson_lambda: 'scalar',
    bounce_cap: 'scalar',
    vintage_min_months: 'scalar',
    vintage_max_months: 'scalar',
    product_manufacturer: 'scalar',
    product_trader: 'scalar',
    product_service: 'scalar'
  },
  history: {
    window_days: 'scalar',
    cohort_days_before_end: 'scalar',
    skip_sundays: 'scalar',
    cohort_min_n: 'scalar',
    roll_target: 'scalar',
    cohort_count_indore: 'scalar',
    cohort_count_ujjain_branch: 'scalar',
    cohort_count_dewas: 'scalar',
    roll_count_indore: 'scalar',
    roll_count_ujjain_branch: 'scalar',
    roll_count_dewas: 'scalar',
    stayed_count_indore: 'scalar',
    stayed_count_ujjain_branch: 'scalar',
    stayed_count_dewas: 'scalar',
    early_count_indore: 'scalar',
    early_count_ujjain_branch: 'scalar',
    early_count_dewas: 'scalar',
    max_cures_per_day: 'scalar',
    reentry_wait_min_days: 'scalar',
    reentry_wait_max_days: 'scalar'
  },
  defects: { missing_alt_mobile_rate: 'scalar', missing_business_name_rate: 'scalar', unmapped_pincode_rate: 'scalar' }
};

/** Raw text -> { section: { key: rawValue } }. Quotes are stripped and lists
 *  are split on commas with trim. Errors name the file and the line. Exported
 *  for the structure-syntax tests; parseSeedConfig is the entry callers use. */
export function parseSeedStructure(text: string, source: string): Record<string, Record<string, string | string[]>> {
  const result: Record<string, Record<string, string | string[]>> = {};
  let section: string | null = null;
  const seen: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const lineNo = index + 1;
    if (line === '' || line.startsWith('#')) {
      return;
    }
    if (line.endsWith(':')) {
      if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
        throw new Error(`${source}:${lineNo}: nested sections are not allowed (${rawLine.trim()}) — only one level of nesting is permitted`);
      }
      section = line.slice(0, -1);
      if (result[section]) {
        throw new Error(`${source}:${lineNo}: duplicate section ${section}`);
      }
      result[section] = {};
      seen.push(section);
      return;
    }
    if (!section) {
      // A `flat: 1` entry with no section header is stored under '' —
      // permitted but never used by the schema.
      section = '';
      if (!result['']) {
        result[''] = {};
        seen.push('');
      }
    }
    const separator = line.indexOf(':');
    if (separator < 1) {
      throw new Error(`${source}:${lineNo}: expected "key: value", got "${line}"`);
    }
    const key = line.slice(0, separator).trim();
    if (key.includes(' ')) {
      throw new Error(`${source}:${lineNo}: keys must not contain spaces ("${key}")`);
    }
    const bucket = result[section]!;
    if (Object.prototype.hasOwnProperty.call(bucket, key)) {
      throw new Error(`${source}:${lineNo}: duplicate key ${section}.${key}`);
    }
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (value.includes(',') && !value.startsWith('#')) {
      bucket[key] = value.split(',').map((part) => part.trim());
    } else {
      bucket[key] = value;
    }
  });
  if (seen.length === 0) {
    throw new Error(`${source}: no sections found`);
  }
  return result;
}

function numberAt(data: Record<string, Record<string, string | string[]>>, path: string, expectList: boolean): number | string | string[] {
  const [section, key] = [path.slice(0, path.indexOf('.')), path.slice(path.indexOf('.') + 1)];
  const bucket = data[section];
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, key)) {
    throw new Error(`${path} is missing from the seed config`);
  }
  const raw = bucket[key]!;
  if (expectList && !Array.isArray(raw)) {
    throw new Error(`${path} must be a comma-separated list`);
  }
  if (!expectList && Array.isArray(raw)) {
    throw new Error(`${path} must be a single value, not a list`);
  }
  return raw;
}

function coerceNumber(data: Record<string, Record<string, string | string[]>>, path: string): number {
  const raw = numberAt(data, path, false);
  const value = Number(raw);
  if (typeof raw !== 'string' || raw === '' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseSeedConfig(text: string, source = 'seed_config.yaml'): SeedConfig {
  const data = parseSeedStructure(text, source);
  for (const sectionName of Object.keys(data)) {
    if (sectionName && !EXPECTED_KEYS[sectionName]) {
      throw new Error(`${source}: unexpected section ${sectionName} (expected: ${Object.keys(EXPECTED_KEYS).join(', ')})`);
    }
  }
  const num = (path: string): number => coerceNumber(data, path);
  const str = (path: string): string => {
    const raw = numberAt(data, path, false);
    if (Array.isArray(raw)) {
      throw new Error(`${path} must be a scalar`);
    }
    return String(raw);
  };
  const list = (path: string): string[] => {
    const raw = numberAt(data, path, true);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${path} must be a non-empty list`);
    }
    return raw;
  };

  const config: SeedConfig = {
    seed: {
      run_date: str('seed.run_date'),
      require_yes_flag: str('seed.require_yes_flag') === 'true',
      require_demo_mode: str('seed.require_demo_mode') === 'true',
      reset_tables: list('seed.reset_tables')
    },
    people: {
      officer_count_indore: num('people.officer_count_indore'),
      officer_count_dewas: num('people.officer_count_dewas'),
      officer_count_ujjain: num('people.officer_count_ujjain'),
      officer_count_ratlam: num('people.officer_count_ratlam'),
      manager_count: num('people.manager_count'),
      officer_capacity_points: num('people.officer_capacity_points'),
      demo_pin: str('people.demo_pin')
    },
    territory: {
      indore_pincode_main: str('territory.indore_pincode_main'),
      indore_pincode_east: str('territory.indore_pincode_east'),
      indore_pincode_south: str('territory.indore_pincode_south'),
      indore_shared_locality: str('territory.indore_shared_locality'),
      dewas_pincode: str('territory.dewas_pincode'),
      dewas_localities: list('territory.dewas_localities'),
      ujjain_pincode: str('territory.ujjain_pincode'),
      ujjain_localities: list('territory.ujjain_localities'),
      ratlam_pincode: str('territory.ratlam_pincode'),
      unmapped_defect_pincode: str('territory.unmapped_defect_pincode')
    },
    loans: {
      total_end_active: num('loans.total_end_active'),
      per_branch_indore: num('loans.per_branch_indore'),
      per_branch_ujjain_branch: num('loans.per_branch_ujjain_branch'),
      per_branch_ujjain_city: num('loans.per_branch_ujjain_city'),
      per_branch_ratlam: num('loans.per_branch_ratlam'),
      per_branch_dewas: num('loans.per_branch_dewas'),
      segment_weights: list('loans.segment_weights').map(Number),
      ticket_median_rupees: num('loans.ticket_median_rupees'),
      ticket_ln_sigma: num('loans.ticket_ln_sigma'),
      ticket_min_rupees: num('loans.ticket_min_rupees'),
      ticket_max_rupees: num('loans.ticket_max_rupees'),
      bounce_poisson_lambda: num('loans.bounce_poisson_lambda'),
      bounce_cap: num('loans.bounce_cap'),
      vintage_min_months: num('loans.vintage_min_months'),
      vintage_max_months: num('loans.vintage_max_months'),
      product_manufacturer: str('loans.product_manufacturer'),
      product_trader: str('loans.product_trader'),
      product_service: str('loans.product_service')
    },
    history: {
      window_days: num('history.window_days'),
      cohort_days_before_end: num('history.cohort_days_before_end'),
      skip_sundays: num('history.skip_sundays'),
      cohort_min_n: num('history.cohort_min_n'),
      roll_target: str('history.roll_target'),
      cohort_count_indore: num('history.cohort_count_indore'),
      cohort_count_ujjain_branch: num('history.cohort_count_ujjain_branch'),
      cohort_count_dewas: num('history.cohort_count_dewas'),
      roll_count_indore: num('history.roll_count_indore'),
      roll_count_ujjain_branch: num('history.roll_count_ujjain_branch'),
      roll_count_dewas: num('history.roll_count_dewas'),
      stayed_count_indore: num('history.stayed_count_indore'),
      stayed_count_ujjain_branch: num('history.stayed_count_ujjain_branch'),
      stayed_count_dewas: num('history.stayed_count_dewas'),
      early_count_indore: num('history.early_count_indore'),
      early_count_ujjain_branch: num('history.early_count_ujjain_branch'),
      early_count_dewas: num('history.early_count_dewas'),
      max_cures_per_day: num('history.max_cures_per_day'),
      reentry_wait_min_days: num('history.reentry_wait_min_days'),
      reentry_wait_max_days: num('history.reentry_wait_max_days')
    },
    defects: {
      missing_alt_mobile_rate: num('defects.missing_alt_mobile_rate'),
      missing_business_name_rate: num('defects.missing_business_name_rate'),
      unmapped_pincode_rate: num('defects.unmapped_pincode_rate')
    }
  };

  validateCrossChecks(config);
  return config;
}

function validateCrossChecks(config: SeedConfig): void {
  const people = config.people;
  const officerTotal = people.officer_count_indore + people.officer_count_dewas + people.officer_count_ujjain + people.officer_count_ratlam;
  if (officerTotal !== 9 || people.manager_count !== 3) {
    throw new Error(`people: expected 9 officers and 3 managers, got ${officerTotal} and ${people.manager_count}`);
  }
  const loans = config.loans;
  if (loans.per_branch_indore + loans.per_branch_ujjain_branch + loans.per_branch_dewas !== loans.total_end_active) {
    throw new Error('loans: branch counts must sum to total_end_active (ujjain_branch includes ratlam)');
  }
  if (loans.per_branch_ujjain_city + loans.per_branch_ratlam !== loans.per_branch_ujjain_branch) {
    throw new Error('loans: ujjain_city + ratlam must equal ujjain_branch');
  }
  const weightSum = loans.segment_weights.reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-9 || loans.segment_weights.length !== 3) {
    throw new Error(`loans: segment_weights must be three values summing to 1, got ${weightSum}`);
  }
  if (loans.ticket_min_rupees >= loans.ticket_median_rupees || loans.ticket_median_rupees >= loans.ticket_max_rupees) {
    throw new Error('loans: require ticket_min < ticket_median < ticket_max');
  }
  const history = config.history;
  const cohortN = history.cohort_count_indore + history.cohort_count_ujjain_branch + history.cohort_count_dewas;
  const rollTotal = history.roll_count_indore + history.roll_count_ujjain_branch + history.roll_count_dewas;
  if (cohortN < history.cohort_min_n) {
    throw new Error(`history: cohort n resolves to ${cohortN} (< ${history.cohort_min_n}); raise the cohort counts`);
  }
  const overallRoll = rollTotal / cohortN;
  if (Math.abs(Number(history.roll_target) - overallRoll) > 0.02) {
    throw new Error(`history: roll counts produce ${overallRoll.toFixed(4)} overall vs configured target ${history.roll_target}`);
  }
  for (const branch of ['indore', 'ujjain_branch', 'dewas'] as const) {
    const numKey = (prefix: string): number => {
      const key = `${prefix}_${branch}` as keyof typeof history;
      const value = history[key];
      if (value === undefined) {
        throw new Error(`history: missing count ${prefix}_${branch}`);
      }
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    };
    const cohort_b = numKey('cohort_count');
    const roll_b = numKey('roll_count');
    const stayed_b = numKey('stayed_count');
    const early_b = numKey('early_count');
    if (roll_b + stayed_b > cohort_b) {
      throw new Error(`history: ${branch} roll+stay exceeds its cohort`);
    }
    const rollRate = roll_b / cohort_b;
    if (rollRate < 0.19 || rollRate > 0.25) {
      throw new Error(`history: ${branch} roll rate ${rollRate.toFixed(4)} must sit between 0.19 and 0.25`);
    }
    const perBranch = branch === 'indore' ? config.loans.per_branch_indore : branch === 'dewas' ? config.loans.per_branch_dewas : config.loans.per_branch_ujjain_branch;
    if (roll_b + stayed_b + early_b > perBranch) {
      throw new Error(`history: ${branch} destiny counts exceed the branch loan count ${perBranch}`);
    }
  }
  if (history.skip_sundays !== 1) {
    throw new Error('history: skip_sundays must be 1 (the importer contract has no Sunday file)');
  }
  if (history.max_cures_per_day >= 60) {
    throw new Error('history: max_cures_per_day must stay far below the vanished_over_40pct abort threshold');
  }
}

// Expected cohort sufficiency is validated by parseSeedConfig; callers reuse
// these resolved sums for the printed summary.
export function cohortCounts(history: SeedConfig['history']): { indore: number; ujjainBranch: number; dewas: number; total: number } {
  const indore = history.cohort_count_indore;
  const ujjainBranch = history.cohort_count_ujjain_branch;
  const dewas = history.cohort_count_dewas;
  return { indore, ujjainBranch, dewas, total: indore + ujjainBranch + dewas };
}

export function loadSeedConfigFile(path: string): SeedConfig {
  return parseSeedConfig(readFileSync(path, 'utf8'), path);
}
