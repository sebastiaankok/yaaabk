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
import type { Issue, IssueGraph, IssuePatch } from '@yaaabk/issues';
import type { Plan } from '@yaaabk/plans';
import type { Project, ProjectPatch, ProvisioningEvent } from '@yaaabk/projects';
import type { SettingsUpdate, SettingsView } from '@yaaabk/settings';
import type { SkillLevel } from '@yaaabk/shared';
import type { ProjectStats } from '@yaaabk/stats';
import type { OpenRouterCreditsView } from './openrouter-balance';

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
    /** Drafts a Finish conflict names as missing. */
    readonly missing: string[] = [],
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
      missing?: unknown;
    };
    const missing = Array.isArray(body.missing)
      ? body.missing.filter((item): item is string => typeof item === 'string')
      : [];
    throw new ApiError(
      response.status,
      body.error ?? 'unknown',
      body.message ?? 'Request failed',
      missing,
    );
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

// --- Settings ----------------------------------------------------------------

export function getSettings(): Promise<SettingsView> {
  return request<SettingsView>('/api/settings');
}

export function updateSettings(update: SettingsUpdate): Promise<SettingsView> {
  return request<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(update) });
}

export interface GitHubVerifyOk {
  ok: true;
  kind: 'pat' | 'app';
  account: string;
}

export interface OpenRouterVerifyOk {
  ok: true;
  keys: number;
  workspaceId?: string;
}

export function verifyGithubSettings(): Promise<GitHubVerifyOk> {
  return request<GitHubVerifyOk>('/api/settings/github/verify', { method: 'POST' });
}

export function verifyOpenrouterSettings(): Promise<OpenRouterVerifyOk> {
  return request<OpenRouterVerifyOk>('/api/settings/openrouter/verify', { method: 'POST' });
}

/** The account balance, the default model and its worst-case reply reservation. */
export function getOpenRouterCredits(): Promise<OpenRouterCreditsView> {
  return request<OpenRouterCreditsView>('/api/settings/openrouter/credits');
}

export type { OpenRouterCreditsView } from './openrouter-balance';

// --- Sessions and models -----------------------------------------------------

/** A model the Plan page may offer for a Grill-Me Session. */
export interface SessionModel {
  /** OpenCode model id, e.g. `openrouter/anthropic/claude-sonnet-4.5`. */
  id: string;
  name: string;
  contextLength: number | null;
  promptUsdPerMillion: number | null;
  completionUsdPerMillion: number | null;
}

export interface ModelCatalogueView {
  models: SessionModel[];
  /** Model the backend uses when neither the request nor the Project chooses. */
  defaultModel: string;
}

/** The live OpenRouter catalogue filtered to tool-capable models. */
export function listModels(): Promise<ModelCatalogueView> {
  return request<ModelCatalogueView>('/api/models');
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
      missing?: unknown;
    };
    const missing = Array.isArray(body.missing)
      ? body.missing.filter((item): item is string => typeof item === 'string')
      : [];
    throw new ApiError(
      response.status,
      body.error ?? 'unknown',
      body.message ?? 'Request failed',
      missing,
    );
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

/** Updates the mutable metadata of a Project. */
export function updateProject(id: string, patch: ProjectPatch): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * Transfers the Project's repository to the Developer's GitHub account. An
 * empty `repoName` keeps the Project name.
 */
export function exportProject(
  id: string,
  input: { owner: string; repoName?: string },
): Promise<Project> {
  const body: Record<string, string> = { owner: input.owner };
  if (input.repoName !== undefined && input.repoName.trim() !== '') {
    body.repoName = input.repoName.trim();
  }
  return request<Project>(`/api/projects/${encodeURIComponent(id)}/export`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** The range the stats dashboard is filtered to, as ISO-8601 instants. */
export interface StatsRange {
  from?: string;
  to?: string;
}

/** Reads a Project's aggregated stats, optionally filtered to a date range. */
export function getProjectStats(projectId: string, range: StatsRange = {}): Promise<ProjectStats> {
  const params = new URLSearchParams();
  if (range.from !== undefined) params.set('from', range.from);
  if (range.to !== undefined) params.set('to', range.to);
  const query = params.toString();
  return request<ProjectStats>(
    `/api/projects/${encodeURIComponent(projectId)}/stats${query === '' ? '' : `?${query}`}`,
  );
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

export function startGrill(
  projectId: string,
  idea: string,
  model?: string,
): Promise<GrillSessionView> {
  const body: Record<string, string> = { idea };
  if (model !== undefined && model.trim() !== '') body.model = model.trim();
  return request<GrillSessionView>(`/api/projects/${encodeURIComponent(projectId)}/grill`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** The live grill session for a Project, or `null` when none is running. */
export async function getActiveGrillSession(projectId: string): Promise<GrillSessionView | null> {
  try {
    return await request<GrillSessionView>(`/api/projects/${encodeURIComponent(projectId)}/grill`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function getGrillSession(projectId: string, sessionId: string): Promise<GrillSessionView> {
  return request<GrillSessionView>(
    `/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}`,
  );
}

export function cancelGrill(projectId: string, sessionId: string): Promise<GrillSessionView> {
  return request<GrillSessionView>(
    `/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}/cancel`,
    { method: 'POST' },
  );
}

/** The published Plan and Issues a finished session produced. */
export interface GrillFinishResult {
  session: GrillSessionView;
  plan: Plan;
  issues: Issue[];
}

/**
 * Publishes a session's drafts. Without both a PRD and Issues the backend
 * answers with a conflict naming what is missing; pass `force` to publish the
 * drafts that exist.
 */
export function finishGrill(
  projectId: string,
  sessionId: string,
  options: { force?: boolean } = {},
): Promise<GrillFinishResult> {
  return request<GrillFinishResult>(
    `/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}/finish`,
    { method: 'POST', body: JSON.stringify({ force: options.force === true }) },
  );
}

/** The WebSocket URL for a session's terminal. */
export function terminalWebSocketUrl(projectId: string, sessionId: string): string {
  const base = API_BASE.replace(/^http/, 'ws');
  return `${base}/api/projects/${encodeURIComponent(projectId)}/grill/${encodeURIComponent(sessionId)}/terminal`;
}

/** A live interactive grill session, as the Plan page sees it. */
export interface GrillSessionView {
  id: string;
  projectId: string;
  status: 'starting' | 'active' | 'finished' | 'cancelled' | 'failed';
  skillLevel: SkillLevel;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  endReason: 'finished' | 'cancelled' | 'replaced' | 'failed' | 'timeout' | null;
  error: string | null;
  terminalPath: string;
  /** What the agent has reported but not yet published. */
  draft: { hasPrd: boolean; issueCount: number };
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
 * Streams a run's output while it is still running.
 *
 * `GET /api/projects/:id/agent-runs/:runId/logs` responds with SSE `log`
 * frames carrying arbitrary chunks, then `end` when the container exits.
 * Resolves when the stream ends; rejects on an `error` frame or on a non-stream
 * response. Pass an abort signal to stop watching.
 */
export async function streamAgentRunLogs(
  projectId: string,
  runId: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(runId)}/logs`,
    {
      headers: { accept: 'text/event-stream' },
      credentials: 'include',
      ...(signal === undefined ? {} : { signal }),
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      body.error ?? 'unknown',
      body.message ?? 'Could not read the agent log',
    );
  }
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    throw new ApiError(response.status, 'unknown', 'Unexpected response to the agent log stream');
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');

      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '{}';
      if (event === 'log') {
        onChunk((JSON.parse(data) as { chunk?: string }).chunk ?? '');
      } else if (event === 'error') {
        const payload = JSON.parse(data) as { message?: string };
        throw new ApiError(
          response.status,
          'unknown',
          payload.message ?? 'Agent log stream failed',
        );
      }
    }
  }
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
