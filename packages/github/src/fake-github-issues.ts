import type {
  CreateGitHubIssueInput,
  GitHubError,
  GitHubIssue,
  GitHubIssues,
  GitHubIssueState,
  GitHubResult,
  UpdateGitHubIssueInput,
} from './types';

/** The operations a fake can be told to fail. */
export type FakeGitHubOperation =
  'ensure-labels' | 'create-issue' | 'update-issue' | 'get-issue' | 'list-issues';

/** One recorded call, for assertions. */
export interface FakeGitHubCall {
  operation: FakeGitHubOperation;
  repo: string;
  number?: number;
  input?: CreateGitHubIssueInput | UpdateGitHubIssueInput;
}

/** A queued failure, keyed to the operation that should hit it. */
interface QueuedFailure {
  operation: FakeGitHubOperation;
  error: GitHubError;
}

export interface FakeGitHubIssues extends GitHubIssues {
  /** Every call made, in order. */
  readonly calls: FakeGitHubCall[];
  /** The Issues on a repository, newest number first. */
  issues(repo: string): GitHubIssue[];
  /** The labels known to a repository. */
  labels(repo: string): string[];
  /** Makes the next call to `operation` fail with `error`. */
  failNext(operation: FakeGitHubOperation, error: GitHubError): void;
  /** Makes the next call to `operation` report an exhausted rate limit. */
  rateLimitNext(operation: FakeGitHubOperation, resetAt?: string): void;
  /** Pretends someone closed (or reopened) an issue on GitHub. */
  setState(repo: string, number: number, state: GitHubIssueState): void;
}

/**
 * An in-memory {@link GitHubIssues} for tests.
 *
 * It behaves like GitHub for the operations syncing needs — allocating issue
 * numbers, tracking labels and states — and exposes hooks to inject failures so
 * retry and back-off logic can be exercised without a network.
 */
export function createFakeGitHubIssues(): FakeGitHubIssues {
  const issuesByRepo = new Map<string, GitHubIssue[]>();
  const labelsByRepo = new Map<string, Set<string>>();
  const calls: FakeGitHubCall[] = [];
  const failures: QueuedFailure[] = [];
  let nextNumber = 1;

  function repoIssues(repo: string): GitHubIssue[] {
    let list = issuesByRepo.get(repo);
    if (list === undefined) {
      list = [];
      issuesByRepo.set(repo, list);
    }
    return list;
  }

  function takeFailure(operation: FakeGitHubOperation): GitHubError | undefined {
    const index = failures.findIndex((failure) => failure.operation === operation);
    if (index === -1) return undefined;
    return failures.splice(index, 1)[0]?.error;
  }

  function fail<T>(operation: FakeGitHubOperation): GitHubResult<T> | undefined {
    const error = takeFailure(operation);
    return error === undefined ? undefined : { ok: false, error };
  }

  return {
    calls,
    issues(repo) {
      return repoIssues(repo).map((issue) => ({ ...issue, labels: [...issue.labels] }));
    },
    labels(repo) {
      return [...(labelsByRepo.get(repo) ?? new Set())];
    },
    failNext(operation, error) {
      failures.push({ operation, error });
    },
    rateLimitNext(operation, resetAt = '2026-01-01T00:00:00.000Z') {
      failures.push({
        operation,
        error: { kind: 'rate-limited', operation, message: 'API rate limit exceeded', resetAt },
      });
    },
    setState(repo, number, state) {
      const issue = repoIssues(repo).find((candidate) => candidate.number === number);
      if (issue !== undefined) issue.state = state;
    },

    async ensureLabels(repo, labels) {
      calls.push({ operation: 'ensure-labels', repo });
      const failed = fail<void>('ensure-labels');
      if (failed !== undefined) return failed;
      const known = labelsByRepo.get(repo) ?? new Set<string>();
      for (const label of labels) known.add(label);
      labelsByRepo.set(repo, known);
      return { ok: true, value: undefined };
    },

    async createIssue(repo, input) {
      calls.push({ operation: 'create-issue', repo, input });
      const failed = fail<GitHubIssue>('create-issue');
      if (failed !== undefined) return failed;
      const issue: GitHubIssue = {
        number: nextNumber++,
        title: input.title,
        body: input.body,
        state: 'open',
        labels: [...input.labels],
      };
      repoIssues(repo).push(issue);
      return { ok: true, value: { ...issue, labels: [...issue.labels] } };
    },

    async updateIssue(repo, number, input: UpdateGitHubIssueInput) {
      calls.push({ operation: 'update-issue', repo, number, input });
      const failed = fail<GitHubIssue>('update-issue');
      if (failed !== undefined) return failed;
      const issue = repoIssues(repo).find((candidate) => candidate.number === number);
      if (issue === undefined) {
        return {
          ok: false,
          error: { kind: 'not-found', operation: 'update-issue', message: 'gone' },
        };
      }
      if (input.title !== undefined) issue.title = input.title;
      if (input.body !== undefined) issue.body = input.body;
      if (input.state !== undefined) issue.state = input.state;
      if (input.labels !== undefined) issue.labels = [...input.labels];
      return { ok: true, value: { ...issue, labels: [...issue.labels] } };
    },

    async getIssue(repo, number) {
      calls.push({ operation: 'get-issue', repo, number });
      const failed = fail<GitHubIssue>('get-issue');
      if (failed !== undefined) return failed;
      const issue = repoIssues(repo).find((candidate) => candidate.number === number);
      if (issue === undefined) {
        return { ok: false, error: { kind: 'not-found', operation: 'get-issue', message: 'gone' } };
      }
      return { ok: true, value: { ...issue, labels: [...issue.labels] } };
    },

    async listIssues(repo) {
      calls.push({ operation: 'list-issues', repo });
      const failed = fail<GitHubIssue[]>('list-issues');
      if (failed !== undefined) return failed;
      return {
        ok: true,
        value: repoIssues(repo).map((issue) => ({ ...issue, labels: [...issue.labels] })),
      };
    },
  };
}
