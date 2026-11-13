/**
 * Typed client for the YAAABK API.
 *
 * The browser calls the backend directly (see `PUBLIC_API_BASE_URL`); requests
 * carry cookies so the backend can set its session cookie. The backend allows
 * this origin through CORS with credentials.
 */

import type { GeneratedIssue } from '@yaaabk/grill-me';
import type { Plan } from '@yaaabk/plans';
import type { Project } from '@yaaabk/projects';

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

// --- Projects, Plans and Grill-Me -------------------------------------------

export function getProject(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`);
}

export function listPlans(projectId: string): Promise<Plan[]> {
  return request<{ plans: Plan[] }>(`/api/projects/${encodeURIComponent(projectId)}/plans`).then(
    (body) => body.plans,
  );
}

/** The active plan, or `null` when the project has none yet. */
export async function getActivePlan(projectId: string): Promise<Plan | null> {
  try {
    return await request<Plan>(`/api/projects/${encodeURIComponent(projectId)}/plans/active`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export function activatePlan(projectId: string, planId: string): Promise<Plan> {
  return request<Plan>(
    `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/activate`,
    { method: 'POST' },
  );
}

export function startGrill(projectId: string, idea: string): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>(`/api/projects/${encodeURIComponent(projectId)}/grill`, {
    method: 'POST',
    body: JSON.stringify({ idea }),
  });
}

export function submitAnswer(
  projectId: string,
  sessionId: string,
  answer: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}/answer`,
    { method: 'POST', body: JSON.stringify({ answer }) },
  );
}

export function cancelGrill(projectId: string, sessionId: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}/cancel`,
    { method: 'POST' },
  );
}

/**
 * Opens the SSE stream for a grill-me session.
 *
 * `EventSource` reconnects automatically and reports the last `id:` it received
 * as `Last-Event-ID`. The backend sends `id:` on every frame so a reconnecting
 * connection can identify where it left off; the current backend does not
 * replay missed events.
 */
export function openGrillStream(projectId: string, sessionId: string): EventSource {
  return new EventSource(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/grill?sessionId=${encodeURIComponent(sessionId)}`,
    { withCredentials: true },
  );
}

/** The payloads the backend forwards on the grill-me SSE stream. */
export interface GrillQuestionEvent {
  sessionId: string;
  question: string;
}

export interface GrillTokenEvent {
  sessionId: string;
  text: string;
}

export interface GrillPlanReadyEvent {
  sessionId: string;
  plan: string;
}

export interface GrillIssuesEvent {
  sessionId: string;
  issues: GeneratedIssue[];
}

export interface GrillErrorEvent {
  sessionId: string;
  error: { kind: string; message: string };
}

export interface GrillEndedEvent {
  sessionId: string;
  reason: 'completed' | 'failed' | 'cancelled' | 'timeout';
}
