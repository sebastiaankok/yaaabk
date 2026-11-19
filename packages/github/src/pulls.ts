import type { GitHubResult } from './types';

/**
 * Public types for the pull-request side of the GitHub integration.
 *
 * The CI Tracker watches the pull requests YAAABK's Agents open: it lists them,
 * reads their check state and mergeability, and merges the ones whose checks
 * passed. The `GitHubPulls` port is deliberately narrow — only the verbs the
 * tracker needs — so it is testable without a network.
 */

/** Whether a pull request's checks are still running, passed, or failed. */
export type GitHubCheckState = 'pending' | 'success' | 'failure';

/** Whether GitHub can currently merge a pull request. */
export type GitHubMergeable = 'mergeable' | 'conflicting' | 'unknown';

/**
 * GitHub's finer-grained merge state. Only the values YAAABK acts on are
 * spelled out; anything GitHub adds later maps to `unknown`.
 */
export type GitHubMergeStateStatus =
  'behind' | 'blocked' | 'clean' | 'dirty' | 'draft' | 'has-hooks' | 'unstable' | 'unknown';

/** A pull request as the CI Tracker sees it. */
export interface GitHubPullRequest {
  number: number;
  url: string;
  /** Branch the pull request's head points at. */
  headRef: string;
  /** Commit SHA of the head, the commit the checks ran against. */
  headSha: string;
  labels: string[];
  draft: boolean;
  /**
   * Mergeability from the list response. GitHub often leaves this `unknown`
   * there; {@link GitHubPulls.mergeability} reads the authoritative value.
   */
  mergeable: GitHubMergeable;
  /** Why the pull request is not mergeable, when GitHub says so. */
  mergeStateStatus: GitHubMergeStateStatus;
}

/** GitHub's current mergeability for one pull request. */
export interface GitHubMergeability {
  mergeable: GitHubMergeable;
  mergeStateStatus: GitHubMergeStateStatus;
}

/** The combined check state of a commit. */
export interface GitHubCheckSummary {
  state: GitHubCheckState;
  /** Names of the failing checks, for logs. Empty unless `state` is `failure`. */
  failed: string[];
  /** How many checks were counted. Zero while CI has not registered any. */
  total: number;
}

/** The merge strategy to use. Defaults to the repository's own. */
export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';

/** A formal review verdict a reviewer may post on a pull request. */
export type GitHubReviewEvent = 'approve' | 'request-changes';

export interface CreateReviewInput {
  /** The verdict to post. */
  event: GitHubReviewEvent;
  /** The reviewer's written summary. */
  body: string;
}

/** A review as YAAABK sees it after posting. */
export interface GitHubReview {
  id: number;
  event: string;
  body: string;
  submittedAt: string;
  /**
   * The commit the review was made against. A review only counts for the pull
   * request's current head commit, so a new push invalidates it.
   */
  commitId: string | null;
}

export interface MergePullRequestInput {
  method?: GitHubMergeMethod;
}

export interface MergePullRequestResult {
  merged: boolean;
  /** The merge commit, when GitHub reported one. */
  sha: string | null;
}

/** The port the CI Tracker drives. */
export interface GitHubPulls {
  /**
   * Open pull requests in `repo`. When `labels` is given, only pull requests
   * carrying every one of those labels are returned.
   */
  listPullRequests(repo: string, labels?: string[]): Promise<GitHubResult<GitHubPullRequest[]>>;
  /** The combined check state of the commit `ref` (usually a head SHA). */
  checkState(repo: string, ref: string): Promise<GitHubResult<GitHubCheckSummary>>;
  /**
   * Reads GitHub's authoritative mergeability for one pull request. The list
   * endpoint often returns `null` here, so a merge decision must not rely on it.
   */
  mergeability(repo: string, number: number): Promise<GitHubResult<GitHubMergeability>>;
  /** Merges a pull request. */
  mergePullRequest(
    repo: string,
    number: number,
    input?: MergePullRequestInput,
  ): Promise<GitHubResult<MergePullRequestResult>>;
  /**
   * Merges the base branch into a pull request's head, the way GitHub's
   * "Update branch" button does. Fails when the branches conflict.
   */
  updatePullRequestBranch(repo: string, number: number): Promise<GitHubResult<void>>;
  /** Posts a formal review on a pull request. */
  createReview(
    repo: string,
    number: number,
    input: CreateReviewInput,
  ): Promise<GitHubResult<GitHubReview>>;
  /** Every review on a pull request, oldest first. */
  listReviews(repo: string, number: number): Promise<GitHubResult<GitHubReview[]>>;
}

/** A check run, reduced to the fields aggregation needs. */
export interface CheckRunSummaryInput {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Statuses that mean a check has not finished yet. */
const PENDING_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

/** Conclusions that make the whole suite a failure. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

/**
 * Collapses a commit's check runs into one state.
 *
 * Pending wins: a suite with anything still running is `pending` even if another
 * check already failed, so the tracker waits rather than reacting twice. No
 * checks at all is also `pending` — CI has not registered yet.
 */
export function summarizeCheckRuns(runs: CheckRunSummaryInput[]): GitHubCheckSummary {
  if (runs.length === 0) {
    return { state: 'pending', failed: [], total: 0 };
  }
  const failed: string[] = [];
  let pending = false;
  for (const run of runs) {
    if (PENDING_STATUSES.has(run.status)) {
      pending = true;
      continue;
    }
    if (run.status !== 'completed' || run.conclusion === null) {
      pending = true;
      continue;
    }
    if (FAILURE_CONCLUSIONS.has(run.conclusion)) {
      failed.push(run.name);
    }
  }
  if (pending) return { state: 'pending', failed: [], total: runs.length };
  if (failed.length > 0) return { state: 'failure', failed, total: runs.length };
  return { state: 'success', failed: [], total: runs.length };
}
