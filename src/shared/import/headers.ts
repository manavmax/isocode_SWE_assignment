export const REQUIRED_COLUMNS = ['loan_id', 'borrower_name', 'outstanding', 'dpd', 'pincode', 'branch'] as const;

export const OPTIONAL_COLUMNS = [
  'business_name',
  'mobile',
  'alt_mobile',
  'address',
  'locality',
  'product',
  'overdue_amount',
  'emi_amount',
  'promise_date',
  'officer',
  'last_due_date'
] as const;

export type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
export type CanonicalColumn = RequiredColumn | OptionalColumn;

const ALIASES: Record<CanonicalColumn, string[]> = {
  loan_id: ['lan', 'loan_id', 'loan_a_c_no', 'loan_account_no', 'loan_no', 'loan_number', 'loan'],
  borrower_name: ['borrower_name', 'borrower', 'customer_name', 'customer', 'name'],
  business_name: ['business_name', 'firm_name', 'business', 'shop_name'],
  mobile: ['mobile', 'mobile_no', 'mobile_number', 'phone', 'phone_no', 'contact_no', 'mobile_no_1'],
  alt_mobile: ['alt_mobile', 'alternate_mobile', 'alt_phone', 'alternate_phone_no', 'secondary_mobile', 'mobile_no_2'],
  address: ['address', 'addr', 'addresses'],
  pincode: ['pincode', 'pin_code', 'pin', 'postal_code', 'zip', 'zip_code'],
  locality: ['locality', 'area', 'locality_area', 'mohalla'],
  branch: ['branch', 'branch_name', 'branch_code'],
  product: ['product', 'product_name', 'loan_type', 'scheme'],
  outstanding: [
    'outstanding',
    'pos',
    'principal_o_s',
    'o_s',
    'os_amount',
    'outstanding_amount',
    'outstanding_balance',
    'principal_outstanding',
    'balance'
  ],
  overdue_amount: ['overdue_amount', 'overdue', 'over_due_amount', 'overdue_amt', 'arrears'],
  emi_amount: ['emi_amount', 'emi', 'installment_amount', 'instalment'],
  dpd: ['dpd', 'days_past_due', 'dpd_days'],
  promise_date: ['promise_date', 'promised_date', 'promise', 'promised_on'],
  officer: ['officer', 'officer_name', 'assigned_officer', 'fo'],
  last_due_date: ['last_due_date', 'last_due', 'due_date', 'last_payment_due_date']
};

export const CANONICAL_COLUMNS = ALIASES;

export function normaliseHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function mapHeaders(headers: string[]): HeaderMap {
  const cols = {} as Record<CanonicalColumn, number>;
  const unmapped: HeaderMap['unmapped'] = [];
  const seen = new Set<CanonicalColumn>();

  headers.forEach((header, index) => {
    const norm = normaliseHeader(header);
    const canonical = findCanonical(norm);
    if (canonical) {
      if (!seen.has(canonical)) {
        cols[canonical] = index;
        seen.add(canonical);
      }
    } else {
      unmapped.push({ index, raw: header, norm });
    }
  });

  const missing = [...REQUIRED_COLUMNS].filter((column) => !(column in cols));
  const suggestions: Partial<Record<RequiredColumn, string>> = {};
  for (const column of missing) {
    const suggestion = nearestUnmapped(unmapped, column);
    if (suggestion) {
      suggestions[column] = suggestion;
    }
  }

  return { cols, headers, unmapped, missing, suggestions };
}

function findCanonical(norm: string): CanonicalColumn | undefined {
  for (const [canonical, aliases] of Object.entries(ALIASES) as [CanonicalColumn, string[]][]) {
    if (aliases.includes(norm)) {
      return canonical;
    }
  }
  return undefined;
}

function nearestUnmapped(unmapped: { raw: string; norm: string }[], column: RequiredColumn): string | undefined {
  let best: { raw: string; distance: number } | undefined;
  for (const entry of unmapped) {
    for (const alias of ALIASES[column]) {
      const distance = levenshtein(entry.norm, alias);
      if (!best || distance < best.distance) {
        best = { raw: entry.raw, distance };
      }
    }
  }
  return best?.raw;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const previous = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    let carry = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(temp + 1, previous[j - 1]! + 1, carry + cost);
      carry = temp;
    }
  }
  return previous[b.length]!;
}

export interface HeaderMap {
  cols: Partial<Record<CanonicalColumn, number>>;
  headers: string[];
  unmapped: { index: number; raw: string; norm: string }[];
  missing: RequiredColumn[];
  suggestions: Partial<Record<RequiredColumn, string>>;
}
