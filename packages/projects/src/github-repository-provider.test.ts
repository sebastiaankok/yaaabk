import { describe, expect, it } from 'vitest';
import { createGitHubRepositoryProvider } from './github-repository-provider';

/** Records requests and answers them with a canned response, for tests. */
function stubFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const REPOSITORY_BODY = {
  full_name: 'acme/todo-app',
  clone_url: 'https://github.com/acme/todo-app.git',
  html_url: 'https://github.com/acme/todo-app',
};

describe('create', () => {
  it('creates an organisation repository and maps the response', async () => {
    const { fetchImpl, calls } = stubFetch(() => json(REPOSITORY_BODY, 201));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.create({ name: 'todo-app', description: 'A todo list' });

    expect(result).toEqual({
      ok: true,
      value: {
        fullName: 'acme/todo-app',
        cloneUrl: 'https://github.com/acme/todo-app.git',
        url: 'https://github.com/acme/todo-app',
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/orgs/acme/repos');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer gh-token',
      accept: 'application/vnd.github+json',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      name: 'todo-app',
      description: 'A todo list',
      private: true,
      auto_init: false,
    });
  });

  it('creates under the authenticated user when configured', async () => {
    const { fetchImpl, calls } = stubFetch(() => json(REPOSITORY_BODY, 201));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      ownerType: 'user',
      fetch: fetchImpl,
    });

    await provider.create({ name: 'todo-app', description: 'A todo list', private: false });

    expect(calls[0]?.url).toBe('https://api.github.com/user/repos');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ private: false });
  });

  it('maps a 422 name clash to already-exists', async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ message: 'Repository creation failed. name already exists on this account' }, 422),
    );
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.create({ name: 'todo-app', description: 'A todo list' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('already-exists');
    expect(result.error.statusCode).toBe(422);
  });

  it('maps a 401 to unauthorized', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: 'Bad credentials' }, 401));
    const provider = createGitHubRepositoryProvider({
      token: 'bad',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.create({ name: 'todo-app', description: 'A todo list' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unauthorized');
  });

  it('maps a network failure to network', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.create({ name: 'todo-app', description: 'A todo list' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
  });
});

describe('delete', () => {
  it('deletes a repository', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.delete('acme/todo-app');

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app');
    expect(calls[0]?.init.method).toBe('DELETE');
  });

  it('maps a 404 to not-found', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: 'Not Found' }, 404));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.delete('acme/missing');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});
