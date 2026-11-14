import {
  summarizeCheckRuns,
  type CheckRunSummaryInput,
  type GitHubCheckState,
  type GitHubCheckSummary,
  type GitHubPullRequest,
  type GitHubPulls,
  type MergePullRequestResult,
} from './pulls';
import type { GitHubError, GitHubResult } from './types';

/** The operations a fake can be told to fail. */
export type FakeGitHubPullsOperation = 'list-pulls' | 'check-state' | 'merge-pull';

/** One recorded call, for assertions. */
export interface FakeGitHubPullsCall {
  operation: FakeGitHubPullsOperation;
  repo: string;
  number?: number;
  ref?: string;
}

/** A pull request to seed, with sensible defaults for the fields Git fills in. */
export interface FakePullRequestInput {
  number: number;
  headRef: string;
  headSha: string;
  url?: string;
  labels?: string[];
  draft?: boolean;
}

/** A queued failure, keyed to the operation that should hit it. */
interface QueuedFailure {
  operation: FakeGitHubPullsOperation;
  error: GitHubError;
}

export interface FakeGitHubPulls extends GitHubPulls {
  /** Every call made, in order. */
  readonly calls: FakeGitHubPullsCall[];
  /** Adds an open pull request and returns it. */
  addPullRequest(repo: string, input: FakePullRequestInput): GitHubPullRequest;
  /** Sets the combined check state for a commit ref. */
  setChecks(
    repo: string,
    ref: string,
    summary: { state: GitHubCheckState; failed?: string[]; total?: number },
  ): void;
  /** Sets check runs, aggregating them the way GitHub would. */
  setCheckRuns(repo: string, ref: string, runs: CheckRunSummaryInput[]): void;
  /** Whether a pull request has been merged. */
  merged(repo: string, number: number): boolean;
  /** Makes the next call to `operation` fail with `error`. */
  failNext(operation: FakeGitHubPullsOperation, error: GitHubError): void;
}

function key(repo: string, value: string | number): string {
  return `${repo}#${value}`;
}

/**
 * An in-memory {@link GitHubPulls} for tests.
 *
 * It behaves like GitHub for the operations the CI Tracker needs — tracking the
 * pull requests opened, the check state of their commits, and which have been
 * merged — and exposes hooks to inject failures so retry and error paths can be
 * exercised without a network.
 */
export function createFakeGitHubPulls(): FakeGitHubPulls {
  const pullsByRepo = new Map<string, GitHubPullRequest[]>();
  const checksByRef = new Map<string, GitHubCheckSummary>();
  const mergedKeys = new Set<string>();
  const calls: FakeGitHubPullsCall[] = [];
  const failures: QueuedFailure[] = [];

  function repoPulls(repo: string): GitHubPullRequest[] {
    let list = pullsByRepo.get(repo);
    if (list === undefined) {
      list = [];
      pullsByRepo.set(repo, list);
    }
    return list;
  }

  function takeFailure(operation: FakeGitHubPullsOperation): GitHubError | undefined {
    const index = failures.findIndex((failure) => failure.operation === operation);
    if (index === -1) return undefined;
    return failures.splice(index, 1)[0]?.error;
  }

  function fail<T>(operation: FakeGitHubPullsOperation): GitHubResult<T> | undefined {
    const error = takeFailure(operation);
    return error === undefined ? undefined : { ok: false, error };
  }

  return {
    calls,

    addPullRequest(repo, input) {
      const pull: GitHubPullRequest = {
        number: input.number,
        url: input.url ?? `https://github.com/${repo}/pull/${input.number}`,
        headRef: input.headRef,
        headSha: input.headSha,
        labels: [...(input.labels ?? [])],
        draft: input.draft ?? false,
      };
      repoPulls(repo).push(pull);
      return { ...pull, labels: [...pull.labels] };
    },

    setChecks(repo, ref, summary) {
      checksByRef.set(key(repo, ref), {
        state: summary.state,
        failed: [...(summary.failed ?? [])],
        total: summary.total ?? 0,
      });
    },

    setCheckRuns(repo, ref, runs) {
      checksByRef.set(key(repo, ref), summarizeCheckRuns(runs));
    },

    merged(repo, number) {
      return mergedKeys.has(key(repo, number));
    },

    failNext(operation, error) {
      failures.push({ operation, error });
    },

    async listPullRequests(repo, labels = []) {
      calls.push({ operation: 'list-pulls', repo });
      const failed = fail<GitHubPullRequest[]>('list-pulls');
      if (failed !== undefined) return failed;
      const value = repoPulls(repo)
        .filter((pull) => !mergedKeys.has(key(repo, pull.number)))
        .filter((pull) => labels.every((label) => pull.labels.includes(label)))
        .map((pull) => ({ ...pull, labels: [...pull.labels] }));
      return { ok: true, value };
    },

    async checkState(repo, ref) {
      calls.push({ operation: 'check-state', repo, ref });
      const failed = fail<GitHubCheckSummary>('check-state');
      if (failed !== undefined) return failed;
      const summary = checksByRef.get(key(repo, ref)) ?? {
        state: 'pending',
        failed: [],
        total: 0,
      };
      return { ok: true, value: { ...summary, failed: [...summary.failed] } };
    },

    async mergePullRequest(
      repo: string,
      number: number,
    ): Promise<GitHubResult<MergePullRequestResult>> {
      calls.push({ operation: 'merge-pull', repo, number });
      const failed = fail<MergePullRequestResult>('merge-pull');
      if (failed !== undefined) return failed;
      mergedKeys.add(key(repo, number));
      return { ok: true, value: { merged: true, sha: `merge-${number}` } };
    },
  };
}
