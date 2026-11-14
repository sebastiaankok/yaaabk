import { describe, expect, it } from 'vitest';
import { createGitHubPullsClient } from './github-pulls-client';

/** A fetch stub that answers from `handler(url, init)`. */
function stubFetch(handler: (path: string, init: RequestInit) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      method: init.method ?? 'GET',
      path,
      ...(init.body === undefined || init.body === null
        ? {}
        : { body: JSON.parse(String(init.body)) }),
    });
    const result = handler(path, init);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(handler: (path: string, init: RequestInit) => unknown) {
  const { fetchImpl, calls } = stubFetch(handler);
  return {
    pulls: createGitHubPullsClient({ token: 't', fetch: fetchImpl }),
    calls,
  };
}

const rawPull = (overrides: { number?: number } & Record<string, unknown> = {}) => {
  const number = overrides.number ?? 7;
  return {
    number,
    html_url: `https://github.com/acme/todo-app/pull/${number}`,
    head: { ref: 'agent/issue-42', sha: 'sha-7' },
    labels: [{ name: 'automerge' }],
    draft: false,
    ...overrides,
  };
};

describe('listPullRequests', () => {
  it('returns open pull requests carrying every requested label', async () => {
    const { pulls, calls } = client(() => [
      rawPull(),
      rawPull({ number: 8, labels: [{ name: 'other' }] }),
      rawPull({ number: 9, labels: [{ name: 'automerge' }, { name: 'wip' }] }),
    ]);

    const result = await pulls.listPullRequests('acme/todo-app', ['automerge', 'wip']);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          number: 9,
          url: 'https://github.com/acme/todo-app/pull/9',
          headRef: 'agent/issue-42',
          headSha: 'sha-7',
          labels: ['automerge', 'wip'],
          draft: false,
        },
      ],
    });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/repos/acme/todo-app/pulls' });
  });

  it('maps a GitHub failure to a typed error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
      })) as typeof fetch;
    const pulls = createGitHubPullsClient({ token: 't', fetch: fetchImpl });

    const result = await pulls.listPullRequests('acme/todo-app');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unauthorized');
  });
});

describe('checkState', () => {
  function stateFor(checkRuns: unknown[]) {
    const { pulls } = client(() => ({ check_runs: checkRuns }));
    return pulls.checkState('acme/todo-app', 'sha-7');
  }

  it('reports success when every check passed', async () => {
    const result = await stateFor([
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'skipped' },
    ]);

    expect(result).toEqual({ ok: true, value: { state: 'success', failed: [], total: 2 } });
  });

  it('reports failure and names the failing checks', async () => {
    const result = await stateFor([
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ]);

    expect(result).toEqual({ ok: true, value: { state: 'failure', failed: ['test'], total: 2 } });
  });

  it('reports pending while any check is still running', async () => {
    const result = await stateFor([
      { name: 'test', status: 'completed', conclusion: 'success' },
      { name: 'build', status: 'in_progress', conclusion: null },
    ]);

    expect(result).toMatchObject({ ok: true, value: { state: 'pending' } });
  });

  it('reports pending when no checks have registered yet', async () => {
    const result = await stateFor([]);

    expect(result).toMatchObject({ ok: true, value: { state: 'pending', total: 0 } });
  });
});

describe('mergePullRequest', () => {
  it('merges with the requested method and reports the merge commit', async () => {
    const { pulls, calls } = client(() => ({ merged: true, sha: 'merge-sha' }));

    const result = await pulls.mergePullRequest('acme/todo-app', 7, { method: 'squash' });

    expect(result).toEqual({ ok: true, value: { merged: true, sha: 'merge-sha' } });
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/repos/acme/todo-app/pulls/7/merge',
      body: { merge_method: 'squash' },
    });
  });
});
