/**
 * Typed client for the YAAABK API.
 *
 * The browser calls the backend directly (see `PUBLIC_API_BASE_URL`); requests
 * carry cookies so the backend can set its session cookie. The backend allows
 * this origin through CORS with credentials.
 */

import { PUBLIC_API_BASE_URL } from '$app/env/public';
import type { AgentRun } from '@yaaabk/agents';
import type { PullSummary, PushSummary, IssueSyncStatus, SyncSummary } from '@yaaabk/github';
import type { GeneratedIssue } from '@yaaabk/grill-me';
import type { Issue, IssueGraph, IssuePatch } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import type { Project, ProvisioningEvent } from '@yaaabk/projects';
import type { SkillLevel } from '@yaaabk/shared';

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

/** Base URL of the backend API. */
const API_BASE = PUBLIC_API_BASE_URL.replace(/\/$/, '');

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

export function listProjects(): Promise<Project[]> {
  return request<{ projects: Project[] }>('/api/projects').then((body) => body.projects);
}

export function createProject(input: {
  name: string;
  description: string;
  skillLevel: SkillLevel;
}): Promise<Project> {
  return request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Creates a Project, streaming provisioning progress as it happens.
 *
 * `POST /api/projects` with `Accept: text/event-stream` responds with an SSE
 * stream: one `progress` frame per provisioning step lifecycle event, then a
 * final `done` frame carrying the created Project — or an `error` frame
 * carrying the failure. Resolves with the Project on `done`; rejects with an
 * `ApiError` on `error` or on a non-stream response (e.g. an auth rejection).
 */
export async function createProjectStream(
  input: { name: string; description: string; skillLevel: SkillLevel },
  onProgress: (event: ProvisioningEvent) => void,
): Promise<Project> {
  const response = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    credentials: 'include',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(response.status, body.error ?? 'unknown', body.message ?? 'Request failed');
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new ApiError(response.status, 'unknown', 'Unexpected response to project creation');
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let settled = false;
  let resolve!: (project: Project) => void;
  let reject!: (cause: unknown) => void;
  const finished = new Promise<Project>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  /** Dispatches one complete SSE frame. */
  function handleFrame(frame: string): void {
    const event = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
    if (event === 'progress') {
      onProgress(JSON.parse(data) as ProvisioningEvent);
      return;
    }
    settled = true;
    if (event === 'done') {
      resolve(JSON.parse(data) as Project);
    } else {
      const payload = JSON.parse(data) as { error?: { kind?: string; message?: string } };
      reject(
        new ApiError(
          response.status,
          payload.error?.kind ?? 'unknown',
          payload.error?.message ?? 'Project creation failed',
        ),
      );
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        handleFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
      if (settled) break;
    }
    if (!settled) {
      reject(new ApiError(response.status, 'unknown', 'Project creation stream ended early'));
    }
  } catch (cause) {
    if (!settled) reject(cause);
  }
  return finished;
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

// --- Issues -----------------------------------------------------------------

export function listIssues(projectId: string): Promise<Issue[]> {
  return request<{ issues: Issue[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues`).then(
    (body) => body.issues,
  );
}

export function getIssueGraph(projectId: string): Promise<IssueGraph> {
  return request<IssueGraph>(`/api/projects/${encodeURIComponent(projectId)}/issues/graph`);
}

export function generateIssues(projectId: string): Promise<Issue[]> {
  return request<{ issues: Issue[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/generate`,
    { method: 'POST' },
  ).then((body) => body.issues);
}

export function refineIssues(projectId: string, feedback: string): Promise<Issue[]> {
  return request<{ issues: Issue[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/refine`,
    { method: 'POST', body: JSON.stringify({ feedback }) },
  ).then((body) => body.issues);
}

export function approveIssues(projectId: string): Promise<Issue[]> {
  return request<{ issues: Issue[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/approve`,
    { method: 'POST' },
  ).then((body) => body.issues);
}

export function updateIssue(projectId: string, issueId: string, patch: IssuePatch): Promise<Issue> {
  return request<Issue>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

export function deleteIssue(projectId: string, issueId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`,
    { method: 'DELETE' },
  );
}

export function getIssueSyncStatus(projectId: string): Promise<IssueSyncStatus> {
  return request<IssueSyncStatus>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/sync/status`,
  );
}

export function pushIssues(projectId: string): Promise<PushSummary> {
  return request<PushSummary>(`/api/projects/${encodeURIComponent(projectId)}/issues/sync/push`, {
    method: 'POST',
  });
}

export function pullIssues(projectId: string): Promise<PullSummary> {
  return request<PullSummary>(`/api/projects/${encodeURIComponent(projectId)}/issues/sync/pull`, {
    method: 'POST',
  });
}

/** Runs a full push-then-pull cycle against GitHub. */
export function syncIssues(projectId: string): Promise<SyncSummary> {
  return request<SyncSummary>(`/api/projects/${encodeURIComponent(projectId)}/issues/sync`, {
    method: 'POST',
  });
}

// --- Agents -----------------------------------------------------------------

/** Every agent run for an issue, oldest first. */
export function listIssueRuns(projectId: string, issueId: string): Promise<AgentRun[]> {
  return request<{ runs: AgentRun[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/runs`,
  ).then((body) => body.runs);
}

/** Every agent run for a project, newest first. */
export function listProjectRuns(projectId: string): Promise<AgentRun[]> {
  return request<{ runs: AgentRun[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/agent-runs`,
  ).then((body) => body.runs);
}

/**
 * Schedules an agent attempt for an issue. An OpenRouter key is optional; the
 * backend provisions a per-attempt Secret from it when given.
 */
export function spawnAgent(
  projectId: string,
  issueId: string,
  options: { openrouterApiKey?: string } = {},
): Promise<AgentRun> {
  return request<AgentRun>(
    `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/spawn`,
    { method: 'POST', body: JSON.stringify(options) },
  );
}
