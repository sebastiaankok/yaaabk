import { githubError, kindForStatus, messageOf, toGitHubError } from './errors';
import type {
  CreateGitHubIssueInput,
  GitHubError,
  GitHubErrorKind,
  GitHubIssue,
  GitHubIssues,
  UpdateGitHubIssueInput,
} from './types';

export interface GitHubIssuesClientOptions {
  /** Personal access or installation token with `issues:write` on the repositories. */
  token: string;
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface RawGitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
}

/** Colours for the YAAABK triage labels; anything else gets a neutral grey. */
const LABEL_COLORS: Record<string, string> = {
  ready: '0e8a16',
  'refinement-needed': 'fbca04',
  blocked: '6e7781',
  'needs-human': 'd73a4a',
};
const DEFAULT_LABEL_COLOR = 'ededed';

function labelNames(labels: RawGitHubIssue['labels']): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name !== '');
}

function toGitHubIssue(raw: RawGitHubIssue): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state === 'closed' ? 'closed' : 'open',
    labels: labelNames(raw.labels),
  };
}

/**
 * Builds the GitHub {@link GitHubIssues} port on the REST API.
 *
 * Thin by design: it speaks only the requests syncing needs, maps responses to
 * the port's own shape, and turns any failure into a typed
 * {@link import('./types').GitHubError}. Rate limiting is reported as the
 * dedicated `rate-limited` kind, with the reset time, so callers can back off
 * rather than treat it as a hard failure.
 */
export function createGitHubIssuesClient(options: GitHubIssuesClientOptions): GitHubIssues {
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

  /** Runs one request, decoding JSON and mapping any failure to a typed error. */
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
    async ensureLabels(repo, labels) {
      try {
        const existing = await send<Array<{ name?: string }>>('list-labels', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/labels?per_page=100`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        const present = new Set(existing.map((label) => label.name));
        for (const name of labels) {
          if (present.has(name)) continue;
          await send('create-label', () =>
            fetchImpl(`${apiBaseUrl}/repos/${repo}/labels`, {
              method: 'POST',
              headers: headers(),
              body: JSON.stringify({ name, color: LABEL_COLORS[name] ?? DEFAULT_LABEL_COLOR }),
            }),
          );
        }
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toGitHubError('ensure-labels', error) };
      }
    },

    async createIssue(repo, input: CreateGitHubIssueInput) {
      try {
        const raw = await send<RawGitHubIssue>('create-issue', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/issues`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
          }),
        );
        return { ok: true, value: toGitHubIssue(raw) };
      } catch (error) {
        return { ok: false, error: toGitHubError('create-issue', error) };
      }
    },

    async updateIssue(repo, number, input: UpdateGitHubIssueInput) {
      try {
        const payload: Record<string, unknown> = {};
        if (input.title !== undefined) payload.title = input.title;
        if (input.body !== undefined) payload.body = input.body;
        if (input.state !== undefined) payload.state = input.state;
        if (input.labels !== undefined) payload.labels = input.labels;
        const raw = await send<RawGitHubIssue>('update-issue', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/issues/${number}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify(payload),
          }),
        );
        return { ok: true, value: toGitHubIssue(raw) };
      } catch (error) {
        return { ok: false, error: toGitHubError('update-issue', error) };
      }
    },

    async getIssue(repo, number) {
      try {
        const raw = await send<RawGitHubIssue>('get-issue', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/issues/${number}`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        return { ok: true, value: toGitHubIssue(raw) };
      } catch (error) {
        return { ok: false, error: toGitHubError('get-issue', error) };
      }
    },

    async listIssues(repo) {
      try {
        const raw = await send<RawGitHubIssue[]>('list-issues', () =>
          fetchImpl(`${apiBaseUrl}/repos/${repo}/issues?state=all&per_page=100`, {
            method: 'GET',
            headers: headers(),
          }),
        );
        return { ok: true, value: raw.map(toGitHubIssue) };
      } catch (error) {
        return { ok: false, error: toGitHubError('list-issues', error) };
      }
    },
  };
}
