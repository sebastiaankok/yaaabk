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
    mergeable: true,
    mergeable_state: 'clean',
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
          mergeable: 'mergeable',
          mergeStateStatus: 'clean',
        },
      ],
    });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/repos/acme/todo-app/pulls' });
  });

  it('maps mergeability and the blocking state', async () => {
    const { pulls } = client(() => [
      rawPull({ number: 7, mergeable: false, mergeable_state: 'dirty' }),
      rawPull({ number: 8, mergeable: true, mergeable_state: 'behind' }),
      rawPull({ number: 9, mergeable: null, mergeable_state: null }),
      rawPull({ number: 10, mergeable: true, mergeable_state: 'has_hooks' }),
    ]);

    const result = await pulls.listPullRequests('acme/todo-app');

    expect(
      result.ok && result.value.map((pull) => [pull.mergeable, pull.mergeStateStatus]),
    ).toEqual([
      ['conflicting', 'dirty'],
      ['mergeable', 'behind'],
      ['unknown', 'unknown'],
      ['mergeable', 'has-hooks'],
    ]);
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

describe('updatePullRequestBranch', () => {
  it('asks GitHub to merge the base into the head', async () => {
    const { pulls, calls } = client(() => ({ message: 'Updating pull request branch.' }));

    const result = await pulls.updatePullRequestBranch('acme/todo-app', 7);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/repos/acme/todo-app/pulls/7/update-branch',
    });
  });

  it('maps a conflict to a typed error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'merge conflict between base and head' }), {
        status: 422,
      })) as typeof fetch;
    const pulls = createGitHubPullsClient({ token: 't', fetch: fetchImpl });

    const result = await pulls.updatePullRequestBranch('acme/todo-app', 7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-input');
      expect(result.error.operation).toBe('update-branch');
    }
  });
});

describe('mergeability', () => {
  it('reads the authoritative single-pull-request endpoint', async () => {
    const { pulls, calls } = client(() => rawPull({ mergeable: false, mergeable_state: 'dirty' }));

    const result = await pulls.mergeability('acme/todo-app', 7);

    expect(result).toEqual({
      ok: true,
      value: { mergeable: 'conflicting', mergeStateStatus: 'dirty' },
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/repos/acme/todo-app/pulls/7',
    });
  });

  it('maps a GitHub failure to a typed error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Not found' }), { status: 404 })) as typeof fetch;
    const pulls = createGitHubPullsClient({ token: 't', fetch: fetchImpl });

    const result = await pulls.mergeability('acme/todo-app', 7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
      expect(result.error.operation).toBe('pull-mergeability');
    }
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

describe('createReview', () => {
  it('posts a review and normalises the verdict', async () => {
    const { pulls, calls } = client(() => ({
      id: 99,
      body: 'Looks good.',
      state: 'APPROVE',
      submitted_at: '2026-01-01T00:00:00Z',
      commit_id: 'sha-7',
    }));

    const result = await pulls.createReview('acme/todo-app', 7, {
      event: 'approve',
      body: 'Looks good.',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: 99,
        event: 'approve',
        body: 'Looks good.',
        submittedAt: '2026-01-01T00:00:00Z',
        commitId: 'sha-7',
      },
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/repos/acme/todo-app/pulls/7/reviews',
      body: { event: 'APPROVE', body: 'Looks good.' },
    });
  });

  it('maps a request-changes verdict', async () => {
    const { pulls, calls } = client(() => ({
      id: 100,
      body: 'Please fix the typo.',
      state: 'REQUEST_CHANGES',
      submitted_at: '2026-01-01T00:00:00Z',
    }));

    const result = await pulls.createReview('acme/todo-app', 7, {
      event: 'request-changes',
      body: 'Please fix the typo.',
    });

    expect(result.ok && result.value.event).toBe('request-changes');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { event: 'REQUEST_CHANGES', body: 'Please fix the typo.' },
    });
  });

  it('maps a GitHub failure to a typed error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Pull request not found' }), {
        status: 404,
      })) as typeof fetch;
    const pulls = createGitHubPullsClient({ token: 't', fetch: fetchImpl });

    const result = await pulls.createReview('acme/todo-app', 7, {
      event: 'approve',
      body: 'Looks good.',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
      expect(result.error.operation).toBe('create-review');
    }
  });
});

describe('listReviews', () => {
  it('returns the reviews in submission order with their head commit', async () => {
    const { pulls, calls } = client(() => [
      {
        id: 11,
        body: 'First pass.',
        state: 'COMMENTED',
        submitted_at: '2026-01-01T00:00:00Z',
        commit_id: 'sha-7',
      },
      {
        id: 12,
        body: 'Looks good.',
        state: 'APPROVE',
        submitted_at: '2026-01-02T00:00:00Z',
        commit_id: 'sha-7',
      },
    ]);

    const result = await pulls.listReviews('acme/todo-app', 7);

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 11,
          event: 'COMMENTED',
          body: 'First pass.',
          submittedAt: '2026-01-01T00:00:00Z',
          commitId: 'sha-7',
        },
        {
          id: 12,
          event: 'approve',
          body: 'Looks good.',
          submittedAt: '2026-01-02T00:00:00Z',
          commitId: 'sha-7',
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/repos/acme/todo-app/pulls/7/reviews',
    });
  });

  it('reads a verdict a comment review carries for a self-authored pull request', async () => {
    const { pulls } = client(() => [
      {
        id: 13,
        body: '<!-- yaaabk-verdict: request-changes -->\n\nFix the /api fallback.',
        state: 'COMMENTED',
        submitted_at: '2026-01-03T00:00:00Z',
        commit_id: 'sha-7',
      },
    ]);

    const result = await pulls.listReviews('acme/todo-app', 7);

    expect(result.ok && result.value[0]).toMatchObject({
      event: 'request-changes',
      body: '<!-- yaaabk-verdict: request-changes -->\n\nFix the /api fallback.',
    });
  });

  it('returns an empty list when the pull request has no reviews', async () => {
    const { pulls } = client(() => []);

    const result = await pulls.listReviews('acme/todo-app', 7);

    expect(result).toEqual({ ok: true, value: [] });
  });

  it('maps a GitHub failure to a typed error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'Pull request not found' }), {
        status: 404,
      })) as typeof fetch;
    const pulls = createGitHubPullsClient({ token: 't', fetch: fetchImpl });

    const result = await pulls.listReviews('acme/todo-app', 7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-found');
      expect(result.error.operation).toBe('list-reviews');
    }
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
