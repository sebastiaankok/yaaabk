/**
 * Typed client for the YAAABK auth API.
 *
 * The browser calls the backend directly (see `PUBLIC_API_BASE_URL`); requests
 * carry cookies so the backend can set its session cookie. The backend allows
 * this origin through CORS with credentials.
 */

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthStatus {
  setupComplete: boolean;
  authenticated: boolean;
  user?: AuthUser;
}

export interface SetupChallenge {
  setupToken: string;
  otpauthUri: string;
  secret: string;
}

export interface LoginChallenge {
  pendingToken: string;
}

/** A failed API call, carrying the backend's typed error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Base URL of the backend API. Empty means same-origin. */
const API_BASE = (import.meta.env.PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    credentials: 'include',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(response.status, body.error ?? 'unknown', body.message ?? 'Request failed');
  }

  return (await response.json()) as T;
}

export function getStatus(): Promise<AuthStatus> {
  return request<AuthStatus>('/api/auth/status');
}

export function beginSetup(input: { username: string; password: string }): Promise<SetupChallenge> {
  return request<SetupChallenge>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function verifySetup(input: {
  setupToken: string;
  token: string;
}): Promise<{ user: AuthUser }> {
  return request('/api/auth/setup/verify', { method: 'POST', body: JSON.stringify(input) });
}

export function login(input: { username: string; password: string }): Promise<LoginChallenge> {
  return request<LoginChallenge>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function verifyTwoFactor(input: {
  pendingToken: string;
  token: string;
}): Promise<{ user: AuthUser }> {
  return request('/api/auth/login/2fa', { method: 'POST', body: JSON.stringify(input) });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' });
}
