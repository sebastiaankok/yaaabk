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
      private: false,
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

describe('addCollaborator', () => {
  it('grants push access to the target user', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 201 }));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.addCollaborator('acme/todo-app', 'dev');

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app/collaborators/dev');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ permission: 'push' });
  });

  it('accepts 204 when the user is already a collaborator', async () => {
    const { fetchImpl } = stubFetch(() => new Response(null, { status: 204 }));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.addCollaborator('acme/todo-app', 'dev');

    expect(result.ok).toBe(true);
  });
});

describe('transfer', () => {
  it('transfers ownership and maps the response to the new identity', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json(
        {
          name: 'todo-app',
          full_name: 'dev/todo-app',
          clone_url: 'https://github.com/dev/todo-app.git',
          html_url: 'https://github.com/dev/todo-app',
        },
        202,
      ),
    );
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.transfer('acme/todo-app', { newOwner: 'dev' });

    expect(result).toEqual({
      ok: true,
      value: {
        fullName: 'dev/todo-app',
        cloneUrl: 'https://github.com/dev/todo-app.git',
        url: 'https://github.com/dev/todo-app',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app/transfer');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ new_owner: 'dev' });
  });

  it('renames the repository when a target name is given', async () => {
    const transferred = {
      name: 'todo-app',
      full_name: 'dev/todo-app',
      clone_url: 'https://github.com/dev/todo-app.git',
      html_url: 'https://github.com/dev/todo-app',
    };
    const renamed = {
      name: 'todo',
      full_name: 'dev/todo',
      clone_url: 'https://github.com/dev/todo.git',
      html_url: 'https://github.com/dev/todo',
    };
    const { fetchImpl, calls } = stubFetch((url) =>
      url.endsWith('/transfer') ? json(transferred, 202) : json(renamed, 200),
    );
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.transfer('acme/todo-app', { newOwner: 'dev', repoName: 'todo' });

    expect(result.ok && result.value.fullName).toBe('dev/todo');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://api.github.com/repos/dev/todo-app');
    expect(calls[1]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ name: 'todo' });
  });

  it('maps a failed transfer to a typed error', async () => {
    const { fetchImpl } = stubFetch(() => json({ message: 'Not Found' }, 404));
    const provider = createGitHubRepositoryProvider({
      token: 'gh-token',
      owner: 'acme',
      fetch: fetchImpl,
    });

    const result = await provider.transfer('acme/missing', { newOwner: 'dev' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });
});
