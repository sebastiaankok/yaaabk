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

/** What an Agent run is for. */
export type AgentRunKind = 'implement-issue' | 'review' | 'resolve-conflicts' | 'deploy';

/** Every valid {@link AgentRunKind}, for validation and the UI. */
export const AGENT_RUN_KINDS: readonly AgentRunKind[] = [
  'implement-issue',
  'review',
  'resolve-conflicts',
  'deploy',
];

/** Narrows an unknown value to an {@link AgentRunKind}. */
export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return typeof value === 'string' && (AGENT_RUN_KINDS as readonly string[]).includes(value);
}

/**
 * The GitHub token scope a run needs. Kept distinct from {@link AgentRunKind}
 * so a new kind can reuse an existing scope rather than minting a new one.
 */
export type AgentTokenScope = 'implement-issue' | 'review' | 'resolve-conflicts' | 'deploy';

/** The verdict a review run reaches. */
export type AgentReviewVerdict = 'approve' | 'request-changes';

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
  /** What the run is for: implementing, reviewing, resolving conflicts, or deploying. */
  kind: AgentRunKind;
  /**
   * 1-based sequence within the run's kind for this Issue. For an
   * implement-issue run this is the Issue's attempt number; review and
   * conflict-resolution runs do not consume the implement-attempt budget, so
   * their sequence counts runs of that kind.
   */
  attemptNumber: number;
  /** The pull request a review run judges, once dispatched. */
  pullNumber: number | null;
  /** The merged commit SHA a deploy run deploys, once dispatched. */
  commitSha: string | null;
  /**
   * The reviewer's summary a fix attempt must address, when it was spawned in
   * response to a request-changes review. `null` for a fresh implement attempt.
   */
  reviewFeedback: string | null;
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
  /**
   * The OpenCode model this attempt invoked, resolved when the Job was created
   * from the Issue, then Project, then environment default. `null` while the
   * run is queued and for deploy runs, which never call a model.
   */
  model: string | null;
  /** Pull request the attempt opened, once it reported one. */
  prUrl: string | null;
  /**
   * The verdict a review run reached, once it reported. `null` for other kinds
   * and for reviews that have not finished.
   */
  reviewVerdict: AgentReviewVerdict | null;
  /** The reviewer's written summary, once the review run reported. */
  reviewBody: string | null;
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
   * What the run is for. Defaults to `implement-issue`; `review` judges a pull
   * request, `resolve-conflicts` merges the base into a conflicting branch and
   * resolves it, and `deploy` deploys the merged commit of a closed pull
   * request.
   */
  kind?: AgentRunKind;
  /**
   * The pull request a review or conflict-resolution run works on. Required for
   * both of those kinds.
   */
  pullNumber?: number;
  /** The merged commit SHA to deploy. Required when `kind` is `deploy`. */
  commitSha?: string;
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
  /**
   * Reviewer summary a fix attempt must address. Rendered as a distinct prompt
   * section by the agent Job; the Issue body is left untouched.
   */
  reviewFeedback?: string;
}

/**
 * Resolves the short-lived GitHub token a run's Job gets, scoped to what that
 * kind of run needs. Implement-issue runs push and open pull requests; review
 * runs only clone and post a review.
 */
export type AgentGithubTokenResolver = (scope: AgentTokenScope) => Promise<string | undefined>;

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

/** What an {@link AgentManager.autoDispatch} pass scheduled. */
export interface AutoDispatchSummary {
  /** Implement runs created for dependency-satisfied `ready` Issues. */
  scheduled: number;
}

/** The fields a Job may report back once it finishes. */
export interface AgentReport {
  /** Pull request the attempt opened. */
  prUrl?: string;
  /** LLM spend attributed to the attempt, in whole cents. */
  costCents?: number;
  /** Captured agent output. */
  logs?: string;
  /** The verdict a review run reached. Omitted by other kinds. */
  reviewVerdict?: AgentReviewVerdict;
  /** The reviewer's written summary. Omitted with {@link reviewVerdict}. */
  reviewBody?: string;
  /** Commit SHA deployed by a successful deploy run. */
  commitSha?: string;
  /**
   * How a deploy run ended. Omitted by runs that are not deploys; a failed
   * deploy is recorded on the Project and surfaced to the Developer.
   */
  deployOutcome?: 'success' | 'failed';
}

/** How much output to stream from a run, and whether to wait for more. */
export interface AgentLogOptions {
  /** Keep the stream open while the Job runs. Defaults to `true`. */
  follow?: boolean;
  /** Newest N lines to start from. Defaults to the Job's recent output. */
  tailLines?: number;
}

/** The kinds of failure an Agent Manager command can report. */
export type AgentErrorKind =
  | 'invalid-input'
  | 'not-found'
  | 'issue-not-synced'
  | 'kubernetes'
  | 'unauthorized'
  | 'budget-exhausted'
  | 'unknown';

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
   * Schedules a run for an Issue. When the concurrency limits leave room the
   * run is dispatched immediately; otherwise it is queued and a later
   * {@link reconcile} dispatches it.
   *
   * A `review` run judges the pull request identified by `pullNumber`. A
   * `resolve-conflicts` run checks out `branch`, merges the base into it and
   * resolves the result. Neither consumes the Issue's implement-attempt budget.
   * A `deploy` run deploys `commitSha` as `yaaabk-deploy` and records the SHA on
   * the Project.
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
   * Starts the Implement Agent for every fresh `ready` Issue whose dependencies
   * are all closed. Issues that are not part of the current dependency wave,
   * already have a run, or carry another label are left alone.
   *
   * Issues beyond the concurrency limits wait for a later pass, after
   * {@link reconcile} has freed their slot.
   */
  autoDispatch(): Promise<AgentsResult<AutoDispatchSummary>>;
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
  /**
   * Streams a run's output for the UI.
   *
   * A finished run yields its stored log; a running one yields its Pod's
   * output live and closes when the container exits. The stream carries text
   * as UTF-8 bytes, so callers can append it verbatim.
   */
  logs(runId: string, options?: AgentLogOptions): Promise<AgentsResult<ReadableStream<Uint8Array>>>;
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
