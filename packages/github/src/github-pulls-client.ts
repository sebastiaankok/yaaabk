import { reviewVerdictFromBody } from '@yaaabk/shared';
import { githubError, kindForStatus, messageOf, toGitHubError } from './errors';
import {
  summarizeCheckRuns,
  type CheckRunSummaryInput,
  type CreateReviewInput,
  type GitHubMergeable,
  type GitHubMergeability,
  type GitHubMergeMethod,
  type GitHubMergeStateStatus,
  type GitHubPullRequest,
  type GitHubPulls,
  type GitHubReview,
  type GitHubReviewEvent,
  type MergePullRequestInput,
  type MergePullRequestResult,
} from './pulls';
import type { GitHubError, GitHubErrorKind } from './types';

export interface GitHubPullsClientOptions {
  /** Token with `contents:write` (to merge) and `checks:read` on the repositories. */
  token: string;
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface RawPull {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  labels: Array<string | { name?: string }>;
  draft?: boolean;
  /** `null` while GitHub is still computing mergeability. */
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}

interface RawCheckRuns {
  check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
}

interface RawMerge {
  merged: boolean;
  sha: string | null;
}

interface RawReview {
  id: number;
  body: string | null;
  state: string;
  submitted_at: string;
  commit_id: string | null;
}

/** GitHub's review states, mapped back to the port's verdicts. */
const REVIEW_EVENTS: Readonly<Record<string, GitHubReviewEvent>> = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request-changes',
};

function toReview(raw: RawReview, fallback: GitHubReviewEvent): GitHubReview {
  return {
    id: raw.id,
    // A review on the Agent's own pull request cannot APPROVE or
    // REQUEST_CHANGES (GitHub answers 422), so it is posted as a COMMENT with
    // the verdict in the body; read that before falling back.
    event: REVIEW_EVENTS[raw.state] ?? reviewVerdictFromBody(raw.body ?? '') ?? fallback,
    body: raw.body ?? '',
    submittedAt: raw.submitted_at,
    commitId: raw.commit_id ?? null,
  };
}

function labelNames(labels: RawPull['labels']): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name !== '');
}

/** Maps GitHub's `mergeable_state` string to the port's own vocabulary. */
function mergeStateStatusOf(raw: RawPull): GitHubMergeStateStatus {
  switch (raw.mergeable_state) {
    case 'behind':
    case 'blocked':
    case 'clean':
    case 'dirty':
    case 'draft':
    case 'unstable':
      return raw.mergeable_state;
    case 'has_hooks':
      return 'has-hooks';
    default:
      return 'unknown';
  }
}

/** Collapses GitHub's nullable `mergeable` flag and state into one verdict. */
function mergeableOf(raw: RawPull): GitHubMergeable {
  if (raw.mergeable === false || raw.mergeable_state === 'dirty') return 'conflicting';
  if (raw.mergeable === true) return 'mergeable';
  // A known non-dirty state is still mergeable as far as YAAABK is concerned;
  // `behind` only means branch protection may require an update first.
  if (raw.mergeable_state !== undefined && raw.mergeable_state !== null) {
    return raw.mergeable_state === 'unknown' ? 'unknown' : 'mergeable';
  }
  return 'unknown';
}

function toPullRequest(raw: RawPull): GitHubPullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    labels: labelNames(raw.labels),
    draft: raw.draft === true,
    mergeable: mergeableOf(raw),
    mergeStateStatus: mergeStateStatusOf(raw),
  };
}

/**
 * Builds the {@link GitHubPulls} port on the REST API.
 *
 * Thin by design, matching the Issue sync's client: it speaks only the requests
 * the CI Tracker needs, maps responses to the port's own shape, and turns any
 * failure into a typed error. An exhausted rate limit is reported as the
 * dedicated `rate-limited` kind so the tracker can back off rather than treat it
 * as a hard failure.
 */
export function createGitHubPullsClient(options: GitHubPullsClientOptions): GitHubPulls {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? fetch;

  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  });

  async function errorMessage(response: Response): Promise<string> {
    const body = (await response.json().catch(() => undefined)) as
      { message?: unknown } | undefined;
    if (body !== undefined && typeof body.message === 'string' && body.message !== '') {
      return body.message;
    }
    return `${response.status} ${response.statusText}`.trim();
  }

  /** Classifies a failed response, preferring an exhausted rate limit. */
  async function failure(response: Response, operation: string): Promise<GitHubError> {
    const message = await errorMessage(response);
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const rateLimited = (response.status === 403 || response.status === 429) && remaining === '0';
    const kind: GitHubErrorKind = rateLimited ? 'rate-limited' : kindForStatus(response.status);
    const details: { statusCode: number; resetAt?: string } = { statusCode: response.status };
    if (rateLimited && reset !== null && /^\d+$/.test(reset)) {
      details.resetAt = new Date(Number(reset) * 1000).toISOString();
    }
    return { kind, operation, message, ...details };
  }

  async function send<T>(operation: string, request: () => Promise<Response>): Promise<T> {
    let response: Response;
    try {
      response = await request();
    } catch (cause) {
      throw githubError('network', messageOf(cause), {}, cause);
    }
    if (!response.ok) {
      throw await failure(response, operation);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw githubError('unknown', 'GitHub returned an unreadable response', {}, cause);
    }
  }

  return {
    async listPullRequests(repo, labels = []) {
      try {
        const raw = await send<RawPull[]>('list-pulls', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls?state=open&per_page=100`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        const pulls = raw
          .map(toPullRequest)
          .filter((pull) => labels.every((label) => pull.labels.includes(label)));
        return { ok: true, value: pulls };
      } catch (error) {
        return { ok: false, error: toGitHubError('list-pulls', error) };
      }
    },

    async mergeability(repo, number) {
      try {
        const raw = await send<RawPull>('pull-mergeability', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${number}`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        const value: GitHubMergeability = {
          mergeable: mergeableOf(raw),
          mergeStateStatus: mergeStateStatusOf(raw),
        };
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: toGitHubError('pull-mergeability', error) };
      }
    },

    async checkState(repo, ref) {
      try {
        const raw = await send<RawCheckRuns>('check-state', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/commits/${ref}/check-runs?per_page=100`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        const runs: CheckRunSummaryInput[] = raw.check_runs.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        }));
        return { ok: true, value: summarizeCheckRuns(runs) };
      } catch (error) {
        return { ok: false, error: toGitHubError('check-state', error) };
      }
    },

    async mergePullRequest(repo, number, input: MergePullRequestInput = {}) {
      try {
        const payload: { merge_method?: GitHubMergeMethod } = {};
        if (input.method !== undefined) payload.merge_method = input.method;
        const raw = await send<RawMerge>('merge-pull', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${number}/merge`, {
            method: 'PUT',
            headers: headers(),
            body: JSON.stringify(payload),
          }),
        );
        const value: MergePullRequestResult = { merged: raw.merged === true, sha: raw.sha ?? null };
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: toGitHubError('merge-pull', error) };
      }
    },

    async updatePullRequestBranch(repo, number) {
      try {
        await send<unknown>('update-branch', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${number}/update-branch`, {
            method: 'PUT',
            headers: headers(),
            body: JSON.stringify({}),
          }),
        );
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toGitHubError('update-branch', error) };
      }
    },

    async createReview(repo, number, input: CreateReviewInput) {
      try {
        const raw = await send<RawReview>('create-review', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${number}/reviews`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
              event: input.event === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
              body: input.body,
            }),
          }),
        );
        return { ok: true, value: toReview(raw, input.event) };
      } catch (error) {
        return { ok: false, error: toGitHubError('create-review', error) };
      }
    },

    async listReviews(repo, number) {
      try {
        const raw = await send<RawReview[]>('list-reviews', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        return {
          ok: true,
          value: raw.map((review) => toReview(review, review.state as GitHubReviewEvent)),
        };
      } catch (error) {
        return { ok: false, error: toGitHubError('list-reviews', error) };
      }
    },
  };
}
