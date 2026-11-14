/**
 * Public domain types for the CI Tracker Module.
 *
 * The CI Tracker closes the agent loop. Agents open pull requests labelled
 * `automerge`; this module polls those pull requests, reads the check suite on
 * each head commit, and then either merges a passing pull request (closing its
 * Issue) or — when checks fail — spawns a fix attempt on the same branch, up to
 * the Issue's attempt budget, after which a human is asked to step in.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK: SQLite
 * stores them as TEXT and they sort lexicographically.
 */

import type { GitHubCheckState } from '@yaaabk/github';

/** What the tracker did for a pull request's current head commit. */
export type WatchAction = 'merged' | 'fix-spawned' | 'needs-human';

/** The tracker's latest view of one watched pull request. */
export interface PullRequestWatch {
  projectId: string;
  /** Full repository name, e.g. `acme/todo-app`. */
  repoFullName: string;
  pullNumber: number;
  /** The pull request's head branch, e.g. `agent/issue-42`. */
  headRef: string;
  /** The head commit the checks ran against. */
  headSha: string;
  /** The Issue the pull request implements. */
  issueId: string;
  /** The check state seen on the last poll. */
  state: GitHubCheckState;
  /** What the tracker did for this head commit, or `null` while undecided. */
  action: WatchAction | null;
  lastCheckedAt: string;
}

/** What one polling pass did. */
export interface CiPollSummary {
  /** Projects scanned. */
  projects: number;
  /** `automerge` pull requests seen (across every Project). */
  pulls: number;
  /** Pull requests whose checks are still running. */
  pending: number;
  /** Pull requests merged because their checks passed. */
  merged: number;
  /** Fix attempts spawned on a failing pull request. */
  fixSpawned: number;
  /** Issues escalated to a human after exhausting their attempts. */
  needsHuman: number;
}

/** The tracker's current configuration and state. */
export interface CiTrackerStatus {
  enabled: boolean;
  intervalMs: number;
  /** When the last pass finished, if one has run. */
  lastCheckedAt: string | null;
  /** Every pull request currently being watched. */
  watches: PullRequestWatch[];
}

/** The configuration a caller may change at runtime. */
export interface CiTrackerConfigPatch {
  enabled?: boolean;
  intervalMs?: number;
}

/** The kinds of failure a CI Tracker command can report. */
export type CiTrackerErrorKind = 'invalid-input' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface CiTrackerError {
  kind: CiTrackerErrorKind;
  /** The operation that failed, e.g. `configure`. */
  operation: string;
  message: string;
}

/** The result of a CI Tracker command: either a value or a typed error. */
export type CiTrackerResult<T> = { ok: true; value: T } | { ok: false; error: CiTrackerError };

/** The scheduling seam, so tests can drive the loop without real time. */
export interface CiTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The CI Tracker's public contract. */
export interface CiTracker {
  /**
   * Runs one polling pass: discovers `automerge` pull requests, reads their
   * check state, and merges or fixes them. Resolves to what the pass changed.
   */
  poll(): Promise<CiTrackerResult<CiPollSummary>>;
  /** The tracker's current configuration and the pull requests it watches. */
  status(): CiTrackerStatus;
  /** Updates the loop's configuration, restarting it when needed. */
  configure(patch: CiTrackerConfigPatch): CiTrackerResult<CiTrackerStatus>;
  /** Starts the polling loop. Idempotent, and a no-op while disabled. */
  start(): void;
  /** Stops the polling loop. Idempotent. */
  stop(): void;
}
