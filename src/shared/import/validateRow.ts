import type { CanonicalColumn } from './headers.js';
import { parseCsvDate, parsePromiseCell } from './dates.js';
import { toPaise } from './money.js';

export interface RowIssue {
  rowNo: number;
  column: string;
  code: string;
  message: string;
}

export interface ImportLoan {
  loanId: string;
  borrowerName: string;
  businessName?: string;
  address?: string;
  locality?: string;
  mobile?: string;
  altMobile?: string;
  pincode: string;
  branch: string;
  product?: string;
  outstanding: number;
  overdueAmount?: number;
  emiAmount?: number;
  dpd: number;
  promiseDate?: string | null;
  promiseNote?: string | null;
  officer?: string;
  lastDueDate?: string | null;
  npa: boolean;
}

export interface ValidateRowCtx {
  branches: ReadonlySet<string>;
  seenLoanIds: Set<string>;
  territoryPincodes?: ReadonlySet<string>;
}

export interface RowValidation {
  status: 'ok' | 'dropped' | 'skipped';
  loan: ImportLoan | null;
  errors: RowIssue[];
  warnings: RowIssue[];
  npa: boolean;
}

type Cols = Partial<Record<CanonicalColumn, number>>;

export function validateRow(
  cells: readonly string[],
  cols: Cols,
  rowNo: number,
  ctx: ValidateRowCtx
): RowValidation {
  const cell = (column: CanonicalColumn): string | undefined => {
    const index = cols[column];
    if (index === undefined) {
      return undefined;
    }
    const raw = cells[index] ?? '';
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const issue = (code: string, column: string, message: string): RowIssue => {
    const item: RowIssue = { rowNo, column, code, message };
    return item;
  };

  const loanId = cell('loan_id');
  const borrowerName = cell('borrower_name');
  const pincode = cell('pincode');
  const branchRaw = cell('branch');
  const outstandingRaw = cell('outstanding');
  const dpdRaw = cell('dpd');

  if (!borrowerName) {
    errors.push(issue('required_cell_missing', 'borrower_name', 'borrower name is required'));
  }
  if (!loanId) {
    errors.push(issue('required_cell_missing', 'loan_id', 'loan id is required'));
  }
  if (loanId) {
    if (ctx.seenLoanIds.has(loanId)) {
      errors.push(issue('duplicate_loan_id', 'loan_id', `loan ${loanId} already appeared earlier in the file`));
    } else {
      ctx.seenLoanIds.add(loanId);
    }
  }

  if (!pincode || !/^[1-9]\d{5}$/.test(pincode)) {
    errors.push(issue('bad_pincode', 'pincode', `pincode ${pincode ?? '(empty)'} is not 6 digits starting 1-9`));
  }

  const branch = branchRaw ? branchRaw.trim().toLowerCase() : undefined;
  if (!branch || !ctx.branches.has(branch)) {
    errors.push(issue('unknown_branch', 'branch', `branch ${branchRaw ?? '(empty)'} is not known`));
  }

  const dpd = dpdRaw && /^\d+$/.test(dpdRaw) ? Number(dpdRaw) : null;
  if (dpd === null || dpdRaw === undefined) {
    errors.push(issue('bad_dpd', 'dpd', `dpd ${dpdRaw ?? '(empty)'} is not a whole number`));
  }

  const outstanding = outstandingRaw === undefined ? null : toPaise(outstandingRaw);
  if (outstandingRaw === undefined) {
    errors.push(issue('required_cell_missing', 'outstanding', 'outstanding is required'));
  } else if (outstanding === null) {
    errors.push(issue('bad_amount', 'outstanding', `amount ${outstandingRaw} is not a valid rupee amount`));
  }

  const overdueRaw = cell('overdue_amount');
  const emiRaw = cell('emi_amount');
  const overdueAmount = overdueRaw === undefined ? undefined : toPaise(overdueRaw);
  const emiAmount = emiRaw === undefined ? undefined : toPaise(emiRaw);
  if (overdueRaw !== undefined && overdueAmount === null) {
    errors.push(issue('bad_amount', 'overdue_amount', `amount ${overdueRaw} is not a valid rupee amount`));
  }
  if (emiRaw !== undefined && emiAmount === null) {
    errors.push(issue('bad_amount', 'emi_amount', `amount ${emiRaw} is not a valid rupee amount`));
  }

  const mobileRaw = cell('mobile');
  const altMobileRaw = cell('alt_mobile');
  const address = cell('address');
  const mobileValid = mobileRaw !== undefined && isValidIndianMobile(mobileRaw);
  const altMobileValid = altMobileRaw !== undefined && isValidIndianMobile(altMobileRaw);
  if (mobileRaw !== undefined && !mobileValid) {
    if (altMobileValid || address) {
      warnings.push(issue('bad_mobile', 'mobile', `mobile ${mobileRaw} is not 10 digits starting 6-9`));
    } else {
      errors.push(issue('no_contact_info', 'mobile', `mobile ${mobileRaw} is invalid and no alt mobile or address is usable`));
    }
  }

  if (dpd === 0) {
    warnings.push(issue('dpd_zero', 'dpd', 'dpd is 0; row is skipped'));
  }

  const territoryPincodes = ctx.territoryPincodes;
  if (territoryPincodes && pincode && /^[1-9]\d{5}$/.test(pincode) && !territoryPincodes.has(pincode)) {
    warnings.push(issue('pincode_not_in_territory', 'pincode', `pincode ${pincode} is not in the territory map`));
  }

  const npa = dpd !== null && dpd > 90;
  const status: RowValidation['status'] =
    errors.length > 0 ? 'dropped' : dpd === 0 ? 'skipped' : 'ok';

  const promiseRaw = cell('promise_date');
  const promise = promiseRaw === undefined ? undefined : parsePromiseCell(promiseRaw);
  const lastDueRaw = cell('last_due_date');
  const lastDueDate = lastDueRaw === undefined ? undefined : parseCsvDate(lastDueRaw);

  const loan: ImportLoan | null =
    status === 'ok' && loanId && borrowerName && pincode && branch && outstanding !== null && dpd !== null
      ? {
        loanId,
        borrowerName,
        businessName: cell('business_name'),
        address,
        locality: cell('locality'),
        mobile: mobileRaw,
        altMobile: altMobileRaw,
        pincode,
        branch: branchRaw!,
        product: cell('product'),
        outstanding,
        overdueAmount: overdueAmount ?? undefined,
        emiAmount: emiAmount ?? undefined,
        dpd,
        promiseDate: promise?.iso,
        promiseNote: promise?.note,
        officer: cell('officer'),
        lastDueDate,
        npa
      }
      : null;

  return { status, loan, errors, warnings, npa };
}

function isValidIndianMobile(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits);
}
