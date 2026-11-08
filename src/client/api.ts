export interface ApiUser {
  username: string;
  role: 'field_officer' | 'branch_manager';
  branchId: string;
  officerId: string | null;
}

export interface ReasonContributionDto {
  feature: string;
  contribution: number;
  evidence: Record<string, number | string>;
}

export interface AssignmentCard {
  loanId: string;
  borrowerName: string;
  pincode: string | null;
  locality: string | null;
  dpd: number;
  bucket: string;
  outstanding: number;
  overdueAmount: number;
  mobileMasked: string | null;
  /** SPEC 8 (prompt 12): present when the book has been scored. */
  score: number | null;
  /** SPEC 13 manager reorder: pinned loans lead the officer's list. */
  pinned: boolean;
  band: 'high' | 'medium' | 'low' | null;
  rupeesAtRisk: number | null;
  topReasons: ReasonContributionDto[] | null;
  limitedData: boolean;
}

export interface LoanDetailDto {
  loanId: string;
  borrowerName: string;
  businessName: string | null;
  address: string | null;
  pincode: string | null;
  locality: string | null;
  product: string | null;
  outstanding: number;
  overdueAmount: number;
  emiAmount: number | null;
  dpd: number;
  bucket: string;
  assignedOfficerId: string | null;
  homeOfficerId: string | null;
  status: 'overdue' | 'cleared' | 'queue';
  mobileMasked: string | null;
  altMobileMasked: string | null;
  score: number | null;
  band: 'high' | 'medium' | 'low' | null;
  rupeesAtRisk: number | null;
  limitedData: boolean;
  topReasons: ReasonContributionDto[] | null;
}

export interface PromiseCardDto {
  promiseId: string;
  loanId: string;
  borrowerName: string;
  /** Paise (A11). */
  amountPaise: number;
  promisedDate: string;
  status: 'open' | 'broken' | 'broken_part';
  loanCleared: boolean;
}

export interface BrokenPromiseCardDto extends PromiseCardDto {
  deadline: string;
  daysPastDue: number;
  needsManagerAttention: boolean;
  stuck: boolean;
}

export interface OfficerPromisesDto {
  dueToday: PromiseCardDto[];
  upcoming: PromiseCardDto[];
  brokenNeedingFollowup: BrokenPromiseCardDto[];
}

/** SPEC 13 (prompt 13): manager surface. English only (A67) — the manager
 *  screens render raw strings, not the bilingual officer dictionary. */
export interface RollTileDto {
  t0: string;
  t1: string;
  cohortN: number;
  rolledN: number;
  cohortAmt: number;
  rolledAmt: number;
  rollRateCount: number;
  rollRateAmount: number;
  wilson: { low: number; high: number } | null;
  greyedOut: boolean;
  loansToSave: number;
}

export interface ManagerDashboardDto {
  branchId: string;
  branchName: string;
  tiles: RollTileDto | null;
  trend: { t0: string; t1: string; rollRateCount: number | null; cohortN: number }[];
  trendWindowsAvailable: number;
  officerTable: {
    officerId: string;
    officerName: string;
    cohortN: number;
    rolledN: number;
    rollRate: number;
    wilson: { low: number; high: number } | null;
    greyedOut: boolean;
    keptRate: number | null;
    keptMade: number;
    workload: number;
  }[];
  migrationTable: { openingBucket: string; cohortN: number; curedShare: number; stayedShare: number; rolledShare: number }[];
  brokenPromises: { promiseId: string; loanId: string; borrowerName: string; amountPaise: number; promisedDate: string; ageDays: number; officerName: string | null }[];
  exceptions: { loanId: string; borrowerName: string; dpd: number; overdueAmount: number; officerName: string | null }[];
  stuckPromises: { promiseId: string; loanId: string; borrowerName: string; amountPaise: number; deadline: string; daysPastDue: number; officerName: string | null }[];
  queueCount: number;
  blockedAttempts30d: number;
  keptRate: number | null;
  keptMade: number;
  openBrokenPromises: number;
}

export interface ActivityRowDto {
  eventId: string;
  loanId: string;
  kind: string;
  outcome: string | null;
  attemptedAtIst: string;
  withinWindow: boolean;
  complianceStatus: string | null;
  gpsStatus: string | null;
  accuracyM: number | null;
}

export interface QueueLoanDto {
  loanId: string;
  borrowerName: string;
  branchName: string;
  dpd: number;
  overdueAmount: number;
  pincode: string | null;
  reason: 'unmapped_pincode' | 'data_fix';
}

export interface BatchRowDto {
  batchId: string;
  asOf: string;
  filename: string;
  status: string;
  totalRows: number;
  imported: number;
  dropped: number;
  errors: number;
  warnings: number;
  createdAt: string;
}

export interface ImportReportDto {
  totalRows: number;
  imported: number;
  dropped: number;
  skipped: number;
  new: number;
  aging: number;
  partPaid: number;
  anomalous: number;
  gone: number;
  warnings: number;
  errors: number;
  paymentsInferred?: number;
  assignment: Record<string, number>;
}

export type ApiError = {
  kind: 'unauthorized' | 'forbidden' | 'notFound' | 'server' | 'network' | 'throttled';
  status: number;
  /** Seconds from the server's Retry-After header (429 only). */
  retryAfterSeconds?: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    return { ok: false, error: { kind: 'network', status: 0 } };
  }
  if (response.status === 401) return { ok: false, error: { kind: 'unauthorized', status: 401 } };
  if (response.status === 403) return { ok: false, error: { kind: 'forbidden', status: 403 } };
  if (response.status === 404) return { ok: false, error: { kind: 'notFound', status: 404 } };
  if (response.status === 429) {
    const retryAfterSeconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    return {
      ok: false,
      error: {
        kind: 'throttled',
        status: 429,
        ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : {})
      }
    };
  }
  if (!response.ok) return { ok: false, error: { kind: 'server', status: response.status } };
  return { ok: true, data: (await response.json()) as T };
}

export const api = {
  demoAccounts: () => request<{ usernames: string[] }>('/api/demo-accounts'),
  login: (username: string, pin: string) =>
    request<{ user: ApiUser }>('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, pin })
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: ApiUser }>('/api/me'),
  assignments: () =>
    request<{ scoringMode: 'scorecard' | 'fallback'; assignments: AssignmentCard[] }>('/api/me/assignments'),
  managerDashboard: () => request<ManagerDashboardDto>('/api/manager/dashboard'),
  officerActivity: (officerId: string) =>
    request<{ activity: ActivityRowDto[] }>(`/api/manager/officers/${encodeURIComponent(officerId)}/activity`),
  pinLoan: (loanId: string, officerId: string) =>
    request<{ ok: boolean }>('/api/manager/priority', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loanId, officerId })
    }),
  unpinLoan: (loanId: string) =>
    request<{ ok: boolean }>(`/api/manager/priority/${encodeURIComponent(loanId)}`, { method: 'DELETE' }),
  managerQueue: () => request<{ queue: QueueLoanDto[] }>('/api/manager/queue'),
  importBatches: () => request<{ batches: BatchRowDto[] }>('/api/manager/import-batches'),
  uploadImport: (form: FormData) => request<{ status: string; batchId?: string; report?: ImportReportDto; abort?: { code: string; message: string } }>('/api/import', { method: 'POST', body: form }),
  promises: () => request<OfficerPromisesDto>('/api/me/promises'),
  loan: (loanId: string) => request<{ loan: LoanDetailDto }>(`/api/loans/${encodeURIComponent(loanId)}`),
  revealPhone: (loanId: string) =>
    request<{ mobile: string | null; altMobile: string | null }>(`/api/loans/${encodeURIComponent(loanId)}/reveal-phone`, {
      method: 'POST'
    })
};
