import { toRepositoryError } from './errors';
import type { Repository, RepositoryProvider } from './repository';

export interface GitHubRepositoryProviderOptions {
  /** Personal access or installation token with permission to create repositories. */
  token: string;
  /** Account the repositories are created under. */
  owner: string;
  /** Whether `owner` is an organisation or the authenticated user. Defaults to `org`. */
  ownerType?: 'org' | 'user';
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface GitHubRepository {
  full_name: string;
  clone_url: string;
  html_url: string;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Builds the GitHub {@link RepositoryProvider} on the REST API.
 *
 * The provider is thin: it speaks only the two requests the Projects Module
 * needs, maps responses to the module's own {@link Repository} shape, and turns
 * any failure into a typed {@link import('./repository').RepositoryError}.
 */
export function createGitHubRepositoryProvider(
  options: GitHubRepositoryProviderOptions,
): RepositoryProvider {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const ownerType = options.ownerType ?? 'org';

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

  return {
    async create(input) {
      try {
        const path = ownerType === 'org' ? `/orgs/${options.owner}/repos` : '/user/repos';
        const response = await fetchImpl(`${apiBaseUrl}${path}`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            name: input.name,
            description: input.description,
            private: input.private ?? true,
            auto_init: false,
          }),
        });
        if (!response.ok) {
          throw httpError(response.status, await errorMessage(response));
        }
        const body = (await response.json()) as GitHubRepository;
        const repository: Repository = {
          fullName: body.full_name,
          cloneUrl: body.clone_url,
          url: body.html_url,
        };
        return { ok: true, value: repository };
      } catch (error) {
        return { ok: false, error: toRepositoryError('create', error) };
      }
    },

    async delete(fullName) {
      try {
        const response = await fetchImpl(`${apiBaseUrl}/repos/${fullName}`, {
          method: 'DELETE',
          headers: headers(),
        });
        if (!response.ok) {
          throw httpError(response.status, await errorMessage(response));
        }
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRepositoryError('delete', error) };
      }
    },
  };
}
