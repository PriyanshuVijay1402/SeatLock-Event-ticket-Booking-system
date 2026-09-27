// Thin fetch wrapper + shared types. The token is the backend's signed mock-auth token.

export interface User {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface EventSummary {
  id: string;
  name: string;
  kind: 'CONCERT' | 'MOVIE';
  venue: string;
  starts_at: string;
  available?: number;
  total?: number;
}

export interface Seat {
  id: number;
  section: string;
  row: string;
  number: number;
  priceCents: number;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED';
}

export interface Hold {
  id: string;
  eventId: string;
  status: string;
  expiresAt: string;
  seatIds: number[];
  seats: { id: number; section: string; row: string; number: number; priceCents: number }[];
  totalCents: number;
}

export interface Booking {
  id: string;
  eventId: string;
  eventName: string;
  startsAt: string;
  seatLabels: string[];
  totalCents: number;
  paymentRef: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ticketing.token';
export const auth = {
  get token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value: string | null) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

export async function api<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 202) {
    throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? res.statusText, data);
  }
  return { status: res.status, data: data as T };
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
