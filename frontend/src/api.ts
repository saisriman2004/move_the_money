// Thin client for /api/v1. Every money value is a string, exactly as the API sends it.

export interface User { id: string; email: string; created_at: string }
export interface Account { id: string; first_name: string; last_name: string; balance: string; created_at: string }
export type TransferKind = 'transfer' | 'deposit' | 'adjustment' | 'refund';
export interface Transfer {
  id: string;
  kind: TransferKind;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  fee: string;
  refund_of: string | null;
  risk_decision: 'approve' | 'review' | null;
  created_at: string;
}
export interface HistoryItem extends Transfer { direction: 'debit' | 'credit' }
export interface LedgerEntry { account_id: string; direction: 'debit' | 'credit'; amount: string; created_at: string }
export interface TransferDetail extends Transfer { refunded_by: string | null; ledger_entries: LedgerEntry[] }
export interface Notification { id: string; type: string; message: string; data: Record<string, unknown>; read_at: string | null; created_at: string }
export interface Webhook { id: string; url: string; events: string[]; active: boolean; created_at: string }
export interface Delivery {
  id: string; event_type: string; status: 'pending' | 'succeeded' | 'dead'; attempts: number;
  last_status_code: number | null; last_error: string | null; next_attempt_at: string; created_at: string;
}

/** An error the API answered with. `status` 0 means no answer at all (network failure). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }

  /** True when we can't know whether the server acted, so a retry must reuse the same key. */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const TOKEN_KEY = 'mtm.token';
let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

export function setToken(value: string | null) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts until the tab closes.
  }
}
export const hasToken = () => token !== null;

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; headers: Headers }> {
  // Send an explicit empty JSON object rather than no body, so every proxy forwards it the same way.
  if (body === undefined && method !== 'GET' && method !== 'DELETE') body = {};
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? `Request failed (${res.status})`), json);
  }
  return { data: json as T, headers: res.headers };
}

export const api = {
  register: (email: string, password: string) => request<{ user: User; token: string }>('POST', '/auth/register', { email, password }).then((r) => r.data),
  login: (email: string, password: string) => request<{ user: User; token: string }>('POST', '/auth/login', { email, password }).then((r) => r.data),
  me: () => request<User>('GET', '/auth/me').then((r) => r.data),

  accounts: () => request<{ data: Account[] }>('GET', '/accounts').then((r) => r.data.data),
  openAccount: (first_name: string, last_name: string, starting_balance: string) =>
    request<Account>('POST', '/accounts', { first_name, last_name, starting_balance }).then((r) => r.data),
  history: (accountId: string, limit = 100) =>
    request<{ data: HistoryItem[] }>('GET', `/accounts/${accountId}/transactions?limit=${limit}`).then((r) => r.data.data),

  transfer: async (from_account_id: string, to_account_id: string, amount: string, idempotencyKey: string) => {
    const { data, headers } = await request<Transfer>('POST', '/transfers', { from_account_id, to_account_id, amount }, { 'Idempotency-Key': idempotencyKey });
    return { transfer: data, replayed: headers.get('Idempotent-Replayed') === 'true' };
  },
  transferDetail: (id: string) => request<TransferDetail>('GET', `/transfers/${id}`).then((r) => r.data),
  refund: (id: string, idempotencyKey: string) =>
    request<Transfer>('POST', `/transfers/${id}/refund`, undefined, { 'Idempotency-Key': idempotencyKey }).then((r) => r.data),

  notifications: () => request<{ data: Notification[]; unread_count: number }>('GET', '/notifications?limit=30').then((r) => r.data),
  markRead: (id: string) => request<unknown>('POST', `/notifications/${id}/read`),
  markAllRead: () => request<unknown>('POST', '/notifications/read-all'),

  webhooks: () => request<{ data: Webhook[] }>('GET', '/webhooks').then((r) => r.data.data),
  createWebhook: (url: string, events: string[]) => request<Webhook & { secret: string }>('POST', '/webhooks', { url, events }).then((r) => r.data),
  deleteWebhook: (id: string) => request<unknown>('DELETE', `/webhooks/${id}`),
  deliveries: (id: string) => request<{ data: Delivery[] }>('GET', `/webhooks/${id}/deliveries`).then((r) => r.data.data),
};
