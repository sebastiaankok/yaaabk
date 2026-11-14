/**
 * Public types for the GitHub integration package.
 *
 * YAAABK mirrors each local Issue to a GitHub Issue on the Project's repository.
 * This package owns the narrow `GitHubIssues` port that mirroring runs through,
 * its REST adapter and an in-memory fake for tests.
 */

/** Whether a GitHub Issue is open or closed. */
export type GitHubIssueState = 'open' | 'closed';

/** A GitHub Issue as YAAABK sees it. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: GitHubIssueState;
  labels: string[];
}

/** The values needed to open a GitHub Issue. */
export interface CreateGitHubIssueInput {
  title: string;
  body: string;
  labels: string[];
}

/** The fields of a GitHub Issue the mirror may change. */
export interface UpdateGitHubIssueInput {
  title?: string;
  body?: string;
  state?: GitHubIssueState;
  labels?: string[];
}

/** The kinds of failure a GitHub operation can report. */
export type GitHubErrorKind =
  | 'invalid-input'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'conflict'
  | 'network'
  | 'unknown';

/** A typed failure, never thrown across the port boundary. */
export interface GitHubError {
  kind: GitHubErrorKind;
  /** The operation that failed, e.g. `create-issue`. */
  operation: string;
  message: string;
  /** HTTP status from GitHub, when the failure came from a response. */
  statusCode?: number;
  /** When a rate limit resets (ISO-8601), when GitHub reported it. */
  resetAt?: string;
}

/** The result of a GitHub operation: either a value or a typed error. */
export type GitHubResult<T> = { ok: true; value: T } | { ok: false; error: GitHubError };

/**
 * The port the Issue mirror runs through.
 *
 * Deliberately narrow: the module speaks only the verbs syncing needs, so a
 * GitLab adapter (or a richer GitHub client) can slot in without touching the
 * sync logic.
 */
export interface GitHubIssues {
  /** Ensures each label exists on the repository, creating the missing ones. */
  ensureLabels(repo: string, labels: string[]): Promise<GitHubResult<void>>;
  /** Opens a new GitHub Issue. */
  createIssue(repo: string, input: CreateGitHubIssueInput): Promise<GitHubResult<GitHubIssue>>;
  /** Updates a GitHub Issue's title, body, state and/or labels. */
  updateIssue(
    repo: string,
    number: number,
    input: UpdateGitHubIssueInput,
  ): Promise<GitHubResult<GitHubIssue>>;
  /** Reads one GitHub Issue. */
  getIssue(repo: string, number: number): Promise<GitHubResult<GitHubIssue>>;
  /** Lists every GitHub Issue on the repository, open or closed. */
  listIssues(repo: string): Promise<GitHubResult<GitHubIssue[]>>;
}

/** How much of a Project's Issue set is mirrored to GitHub. */
export interface IssueSyncStatus {
  /** Local Issues in the Project. */
  total: number;
  /** Local Issues that exist on GitHub. */
  synced: number;
  /** Local Issues not yet pushed to GitHub. */
  pending: number;
  /** When the Project last synced with GitHub, if it has. */
  lastSyncedAt: string | null;
}

/** What a push did. */
export interface PushSummary {
  created: number;
  updated: number;
  status: IssueSyncStatus;
}

/** What a pull did. */
export interface PullSummary {
  /** Local Issues whose workflow state changed from GitHub's. */
  changed: number;
  status: IssueSyncStatus;
}

/** What a full push-then-pull cycle did. */
export interface SyncSummary {
  push: PushSummary;
  pull: PullSummary;
}

/** The kinds of failure an Issue sync command can report. */
export type IssueSyncErrorKind = 'invalid-input' | 'not-found' | 'github' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface IssueSyncError {
  kind: IssueSyncErrorKind;
  /** The operation that failed, e.g. `push`. */
  operation: string;
  message: string;
  /** The underlying GitHub failure, when the sync failed talking to GitHub. */
  github?: GitHubError;
}

/** The result of a sync command: either a value or a typed error. */
export type IssueSyncResult<T> = { ok: true; value: T } | { ok: false; error: IssueSyncError };

/** The Issue sync module's public contract. */
export interface IssueSyncModule {
  /** Creates or updates the Project's approved Issues on GitHub. */
  push(projectId: string, repoFullName: string): Promise<IssueSyncResult<PushSummary>>;
  /** Pulls GitHub's open/closed state back onto the Project's Issues. */
  pull(projectId: string, repoFullName: string): Promise<IssueSyncResult<PullSummary>>;
  /** Pushes, then pulls — the manual "Sync with GitHub" cycle. */
  sync(projectId: string, repoFullName: string): Promise<IssueSyncResult<SyncSummary>>;
  /** How much of the Project's Issue set is mirrored to GitHub. */
  status(projectId: string): Promise<IssueSyncResult<IssueSyncStatus>>;
}
