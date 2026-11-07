export interface ApiUser {
  username: string;
  role: 'field_officer' | 'branch_manager';
  branchId: string;
  officerId: string | null;
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
  assignments: () => request<{ assignments: AssignmentCard[] }>('/api/me/assignments'),
  loan: (loanId: string) => request<{ loan: LoanDetailDto }>(`/api/loans/${encodeURIComponent(loanId)}`),
  revealPhone: (loanId: string) =>
    request<{ mobile: string | null; altMobile: string | null }>(`/api/loans/${encodeURIComponent(loanId)}/reveal-phone`, {
      method: 'POST'
    })
};
