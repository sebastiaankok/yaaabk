/**
 * Public domain types for the Agent Manager Module.
 *
 * The Agent Manager owns the lifecycle of the per-Issue Kubernetes Jobs that
 * implement a Project's Issues. It accepts an Issue to work on, respects the
 * per-Project and cluster-wide concurrency limits, creates a Job (with a
 * working PVC and its credentials mounted from Secrets), watches the Job to
 * completion, and either records the result or schedules another attempt.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK: SQLite
 * stores them as TEXT and they sort lexicographically.
 */

/** Where an Agent run is in its lifecycle. */
export type AgentRunStatus = 'queued' | 'running' | 'success' | 'failed';

/** Every valid {@link AgentRunStatus}, for validation and the UI. */
export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'queued',
  'running',
  'success',
  'failed',
];

/** The statuses a run has not yet left. */
export const ACTIVE_RUN_STATUSES: readonly AgentRunStatus[] = ['queued', 'running'];

/** Narrows an unknown value to an {@link AgentRunStatus}. */
export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

/** Returns whether a run is still in flight. */
export function isActiveRun(status: AgentRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** One attempt at implementing an Issue. */
export interface AgentRun {
  /** Stable internal id (uuid). */
  id: string;
  projectId: string;
  issueId: string;
  /** 1-based attempt number, matching the Issue's attempt count at scheduling. */
  attemptNumber: number;
  /** The Kubernetes Job name, once the attempt has been dispatched. */
  jobName: string | null;
  /** The PersistentVolumeClaim holding the attempt's working tree, once dispatched. */
  pvcName: string | null;
  /**
   * Name of the per-attempt Secret holding the OpenRouter key, when one was
   * provisioned. The Job reads the key from the Secret by name.
   */
  openrouterSecretName: string | null;
  /**
   * The branch the attempt works on, when it is a fix attempt against an
   * existing pull request rather than a fresh Issue's work. `null` means the
   * agent branches from the default branch.
   */
  branch: string | null;
  status: AgentRunStatus;
  /** Pull request the attempt opened, once it reported one. */
  prUrl: string | null;
  /** Captured agent output, when available. */
  logs: string | null;
  /** LLM spend attributed to the attempt, in whole cents. */
  costCents: number;
  createdAt: string;
  /** When the Job was created, if it has been dispatched. */
  startedAt: string | null;
  /** When the attempt reached a terminal status, if it has. */
  finishedAt: string | null;
}

/**
 * A run as persisted, carrying the hash of the token the Job uses to report
 * back. The hash never leaves the module: {@link AgentRun} is what callers see.
 */
export interface StoredAgentRun extends AgentRun {
  /** SHA-256 hex of the per-run report token. */
  tokenHash: string;
}

/** What a caller may tune when spawning an attempt. */
export interface SpawnOptions {
  /**
   * OpenRouter key the Job uses for its LLM calls. When given, the module
   * creates a per-attempt Secret the Job reads it from.
   */
  openrouterApiKey?: string;
  /**
   * Branch the attempt works on. Set for a fix attempt against an existing
   * pull request, so the agent checks that branch out instead of branching
   * fresh from the default branch.
   */
  branch?: string;
}

/** A snapshot of what the scheduler currently sees. */
export interface Capacity {
  /** Running attempts for the given Project. */
  project: number;
  /** Running attempts across every Project. */
  cluster: number;
  /** The configured per-Project limit. */
  maxPerProject: number;
  /** The configured cluster-wide limit. */
  maxCluster: number;
}

/** What a {@link AgentManager.reconcile} pass changed. */
export interface ReconcileSummary {
  /** Queued attempts that were given a Job. */
  dispatched: number;
  /** Attempts whose Jobs finished successfully. */
  succeeded: number;
  /** Attempts whose Jobs failed. */
  failed: number;
  /** Issues that exhausted their attempts and now need a human. */
  escalated: number;
}

/** The fields a Job may report back once it finishes. */
export interface AgentReport {
  /** Pull request the attempt opened. */
  prUrl?: string;
  /** LLM spend attributed to the attempt, in whole cents. */
  costCents?: number;
  /** Captured agent output. */
  logs?: string;
}

/** The kinds of failure an Agent Manager command can report. */
export type AgentErrorKind =
  'invalid-input' | 'not-found' | 'issue-not-synced' | 'kubernetes' | 'unauthorized' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface AgentError {
  kind: AgentErrorKind;
  /** The operation that failed, e.g. `spawn`. */
  operation: string;
  message: string;
}

/** The result of an Agent Manager command: either a value or a typed error. */
export type AgentsResult<T> = { ok: true; value: T } | { ok: false; error: AgentError };

/** The Agent Manager's public contract. */
export interface AgentManager {
  /**
   * Schedules an attempt for an Issue. When the concurrency limits leave room
   * the attempt is dispatched immediately; otherwise it is queued and a later
   * {@link reconcile} dispatches it.
   */
  spawn(
    projectId: string,
    issueId: string,
    options?: SpawnOptions,
  ): Promise<AgentsResult<AgentRun>>;
  /** Every run for an Issue, oldest first. */
  runs(projectId: string, issueId: string): Promise<AgentsResult<AgentRun[]>>;
  /** Every run for a Project, newest first. */
  projectRuns(projectId: string): Promise<AgentsResult<AgentRun[]>>;
  /**
   * Advances every in-flight attempt: dispatches queued runs while capacity
   * allows, records finished Jobs, and retries or escalates failures.
   */
  reconcile(): Promise<AgentsResult<ReconcileSummary>>;
  /** What the scheduler currently sees for a Project. */
  capacity(projectId?: string): AgentsResult<Capacity>;
  /**
   * Records what an attempt's Job reported, authenticating with the token the
   * Job was given.
   */
  report(runId: string, token: string, report: AgentReport): Promise<AgentsResult<AgentRun>>;
}

/**
 * The persistence port the Agent Manager is built on.
 *
 * Deliberately synchronous, matching the other Modules' stores: the production
 * adapter is `bun:sqlite`, which is synchronous, and so is the fake.
 */
export interface AgentStore {
  /** Persists a new run. */
  create(run: StoredAgentRun): void;
  get(runId: string): StoredAgentRun | undefined;
  /** Every run for a Project, newest first. */
  listForProject(projectId: string): StoredAgentRun[];
  /** Every run for an Issue, oldest first. */
  listForIssue(projectId: string, issueId: string): StoredAgentRun[];
  /** Every run still in flight (queued or running), oldest first. */
  listActive(): StoredAgentRun[];
  /** Persists a changed run. */
  update(run: StoredAgentRun): void;
}
