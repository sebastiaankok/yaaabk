import type { GitHubFile, GitHubContents, WriteGitHubFileInput } from './contents';
import { githubError, kindForStatus, messageOf, toGitHubError } from './errors';
import type { GitHubError, GitHubErrorKind } from './types';

export interface GitHubContentsClientOptions {
  /** Token with `contents:write` on the repositories. */
  token: string;
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface RawContentFile {
  path: string;
  sha: string;
  encoding?: string;
  content?: string;
}

interface RawWriteResponse {
  content?: { sha?: string };
}

/** Percent-encodes a repository path without touching its separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Decodes GitHub's base64 file payload, tolerating embedded newlines. */
function decodeContent(raw: RawContentFile): GitHubFile {
  const encoded = (raw.content ?? '').replace(/\s/g, '');
  return {
    path: raw.path,
    sha: raw.sha,
    content: Buffer.from(encoded, 'base64').toString('utf8'),
  };
}

/**
 * Builds the {@link GitHubContents} port on the REST API.
 *
 * Thin by design, matching the Issues and Pulls clients: it speaks only the
 * requests recording an accepted Plan needs, maps failures to typed errors, and
 * turns an exhausted rate limit into the dedicated `rate-limited` kind.
 */
export function createGitHubContentsClient(options: GitHubContentsClientOptions): GitHubContents {
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

  /** Reads one file, mapping `404` to absence rather than failure. */
  async function read(repo: string, path: string): Promise<GitHubFile | null> {
    try {
      const raw = await send<RawContentFile>('read-file', () =>
        fetchImpl(`${apiBaseUrl}/repos/${repo}/contents/${encodePath(path)}`, {
          method: 'GET',
          headers: headers(),
        }),
      );
      return decodeContent(raw);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { kind?: unknown }).kind === 'not-found'
      ) {
        return null;
      }
      throw error;
    }
  }

  return {
    async readFile(repo, path) {
      try {
        return { ok: true, value: await read(repo, path) };
      } catch (error) {
        return { ok: false, error: toGitHubError('read-file', error) };
      }
    },

    async writeFile(repo, path, input: WriteGitHubFileInput) {
      try {
        const existing = await read(repo, path);
        if (existing !== null && existing.content === input.content) {
          return { ok: true, value: { status: 'unchanged', sha: existing.sha } };
        }

        const payload: { message: string; content: string; sha?: string } = {
          message: input.message,
          content: Buffer.from(input.content, 'utf8').toString('base64'),
        };
        if (existing !== null) payload.sha = existing.sha;

        const raw = await send<RawWriteResponse>(
          existing === null ? 'create-file' : 'update-file',
          () =>
            fetchImpl(`${apiBaseUrl}/repos/${repo}/contents/${encodePath(path)}`, {
              method: 'PUT',
              headers: headers(),
              body: JSON.stringify(payload),
            }),
        );
        return {
          ok: true,
          value: {
            status: existing === null ? 'created' : 'updated',
            sha: raw.content?.sha ?? existing?.sha ?? null,
          },
        };
      } catch (error) {
        return { ok: false, error: toGitHubError('write-file', error) };
      }
    },
  };
}
