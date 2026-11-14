/**
 * Public domain types for the Issues Module.
 *
 * An Issue is a unit of work derived from a Plan. It maps 1:1 to a GitHub Issue
 * on the Project's repository and is stored both locally and on GitHub. Locally
 * it also carries YAAABK-only state — the agent attempt budget, the resolved
 * dependency graph and the per-issue OpenRouter key — that never round-trips.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK: SQLite
 * stores them as TEXT and they sort lexicographically.
 */

/** Where an Issue is in its workflow. */
export type IssueStatus = 'open' | 'in_progress' | 'closed' | 'failed';

/** The triage label an Issue carries, mirrored to GitHub. */
export type IssueLabel = 'ready' | 'refinement-needed' | 'blocked' | 'needs-human';

/** Every valid {@link IssueStatus}, for validation and the UI. */
export const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'in_progress', 'closed', 'failed'];

/** Every valid {@link IssueLabel}, for validation and the UI. */
export const ISSUE_LABELS: readonly IssueLabel[] = [
  'ready',
  'refinement-needed',
  'blocked',
  'needs-human',
];

/** Narrows an unknown value to an {@link IssueStatus}. */
export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value);
}

/** Narrows an unknown value to an {@link IssueLabel}. */
export function isIssueLabel(value: unknown): value is IssueLabel {
  return typeof value === 'string' && (ISSUE_LABELS as readonly string[]).includes(value);
}

/** An Issue as persisted and handed to the UI. */
export interface Issue {
  /** Stable internal id (uuid). */
  id: string;
  /** The Project this Issue belongs to. */
  projectId: string;
  /** The Plan it was generated from, when there is one. */
  planId: string | null;
  /** The GitHub Issue number, once synced. */
  githubNumber: number | null;
  /** When the Issue last synced with GitHub, if it has. */
  githubSyncedAt: string | null;
  title: string;
  body: string;
  status: IssueStatus;
  label: IssueLabel;
  /**
   * Titles of Issues that must be implemented first. Stored as titles (what the
   * grill-me skill emits) and resolved to ids by {@link buildIssueGraph}.
   */
  dependsOn: string[];
  /** How many Agent attempts have run. */
  attemptCount: number;
  /** The cap on Agent attempts before escalation. */
  maxAttempts: number;
  /** Per-Issue OpenRouter budget, in whole cents. */
  budgetCents: number;
  /** Hash of the OpenRouter key provisioned for this Issue, when any. */
  openrouterKeyHash: string | null;
  /** When the Issue was closed, if it has been. */
  closedAt: string | null;
  createdAt: string;
}

/** The values needed to create an Issue. */
export interface NewIssue {
  projectId: string;
  planId?: string | null;
  title: string;
  body?: string;
  label?: IssueLabel;
  dependsOn?: string[];
  budgetCents?: number;
  maxAttempts?: number;
}

/** An Issue as emitted by the grill-me skill, before validation. */
export interface GeneratedIssueInput {
  title: string;
  body: string;
  labels: string[];
  depends_on: string[];
}

/** The fields of an Issue a Developer or the Agent workflow may change. */
export interface IssuePatch {
  title?: string;
  body?: string;
  status?: IssueStatus;
  label?: IssueLabel;
  dependsOn?: string[];
  budgetCents?: number;
  maxAttempts?: number;
  githubNumber?: number | null;
  githubSyncedAt?: string | null;
  openrouterKeyHash?: string | null;
  closedAt?: string | null;
}

/** The kinds of failure an Issues Module command can report. */
export type IssueErrorKind =
  'invalid-input' | 'duplicate-title' | 'not-found' | 'cycle' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface IssueError {
  kind: IssueErrorKind;
  /** The operation that failed, e.g. `create`. */
  operation: string;
  message: string;
}

/** The result of an Issues Module command: either a value or a typed error. */
export type IssuesResult<T> = { ok: true; value: T } | { ok: false; error: IssueError };

/** One Issue's place in the dependency graph. */
export interface IssueGraphNode {
  id: string;
  title: string;
  /** Ids of the Issues this one depends on, resolved from titles. */
  dependsOn: string[];
  /** Dependency titles that match no Issue in the graph. */
  missing: string[];
  /** 0-based wave, or `null` when the Issue sits on a cycle. */
  wave: number | null;
}

/** The dependency DAG the UI renders, with waves and any cycles. */
export interface IssueGraph {
  nodes: IssueGraphNode[];
  /** Each detected cycle as the ids that form it, in dependency order. */
  cycles: string[][];
}

/**
 * The persistence port the Issues Module is built on.
 *
 * Deliberately synchronous, matching the Projects, Plans and Auth Modules'
 * stores: the production adapter is `bun:sqlite`, which is synchronous, and so
 * is the fake.
 */
export interface IssueStore {
  /** Persists a new Issue. Throws a duplicate-title error on a clash. */
  create(issue: Issue): void;
  /** Returns an Issue only when it belongs to the given Project. */
  get(projectId: string, issueId: string): Issue | undefined;
  /** Every Issue for a Project, oldest first. */
  list(projectId: string): Issue[];
  /** Persists a changed Issue. */
  update(issue: Issue): void;
  /** Removes an Issue from a Project. */
  delete(projectId: string, issueId: string): void;
}

/** The Issues Module's public contract. */
export interface IssuesModule {
  /** Creates and records one Issue. */
  create(input: NewIssue): Promise<IssuesResult<Issue>>;
  /**
   * Replaces the draft Issues a Plan has so far with a fresh set the grill-me
   * skill generated, so repeated `<ISSUES>` emissions do not accumulate.
   */
  replaceForPlan(
    projectId: string,
    planId: string,
    generated: GeneratedIssueInput[],
  ): Promise<IssuesResult<Issue[]>>;
  /** Every Issue for a Project, oldest first. */
  list(projectId: string): Promise<IssuesResult<Issue[]>>;
  get(projectId: string, issueId: string): Promise<IssuesResult<Issue>>;
  /** Updates the mutable fields of an Issue. */
  update(projectId: string, issueId: string, patch: IssuePatch): Promise<IssuesResult<Issue>>;
  remove(projectId: string, issueId: string): Promise<IssuesResult<void>>;
  /** Marks every Issue in a Project `ready`, finalising the reviewed set. */
  approve(projectId: string): Promise<IssuesResult<Issue[]>>;
  /** The dependency graph for a Project, with waves and cycles. */
  graph(projectId: string): Promise<IssuesResult<IssueGraph>>;
}
