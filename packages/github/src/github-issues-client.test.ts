import { describe, expect, it } from 'vitest';
import { createGitHubIssuesClient } from './github-issues-client';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A scripted `fetch` that records calls and replays queued responses. */
function scriptedFetch(responses: Array<Response | (() => Response)>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const next = responses[index++];
    if (next === undefined) throw new Error(`unexpected request ${index}: ${url}`);
    return typeof next === 'function' ? next() : next.clone();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch) {
  return createGitHubIssuesClient({ token: 'gh-token', fetch: fetchImpl });
}

describe('createGitHubIssuesClient', () => {
  it('opens an issue and maps the response', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json({ number: 7, title: 'Add login', body: 'body text', state: 'open', labels: ['ready'] }),
    ]);

    const result = await client(fetchImpl).createIssue('acme/todo-app', {
      title: 'Add login',
      body: 'body text',
      labels: ['ready'],
    });

    expect(result).toEqual({
      ok: true,
      value: { number: 7, title: 'Add login', body: 'body text', state: 'open', labels: ['ready'] },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app/issues');
    expect(calls[0]?.body).toEqual({ title: 'Add login', body: 'body text', labels: ['ready'] });
  });

  it('updates an issue', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json({ number: 7, title: 'Done', body: 'b', state: 'closed', labels: [] }),
    ]);

    const result = await client(fetchImpl).updateIssue('acme/todo-app', 7, {
      title: 'Done',
      state: 'closed',
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app/issues/7');
    expect(calls[0]?.body).toEqual({ title: 'Done', state: 'closed' });
  });

  it('reads one issue, mapping a missing one to not-found', async () => {
    const { fetch: fetchImpl } = scriptedFetch([json({ message: 'Not Found' }, 404)]);

    const result = await client(fetchImpl).getIssue('acme/todo-app', 99);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not-found');
  });

  it('maps an exhausted rate limit to rate-limited, with the reset time', async () => {
    const resetSeconds = 1_800_000_000;
    const { fetch: fetchImpl } = scriptedFetch([
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetSeconds),
      }),
    ]);

    const result = await client(fetchImpl).createIssue('acme/todo-app', {
      title: 't',
      body: 'b',
      labels: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.resetAt).toBe(new Date(resetSeconds * 1000).toISOString());
    }
  });

  it('maps a plain 401 to unauthorized', async () => {
    const { fetch: fetchImpl } = scriptedFetch([json({ message: 'Bad credentials' }, 401)]);

    const result = await client(fetchImpl).listIssues('acme/todo-app');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('unauthorized');
  });

  it('creates only the labels that are missing', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json([{ name: 'ready' }]),
      json({ name: 'needs-human' }, 201),
    ]);

    const result = await client(fetchImpl).ensureLabels('acme/todo-app', ['ready', 'needs-human']);

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/todo-app/labels?per_page=100');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/acme/todo-app/labels');
    expect((calls[1]?.body as { name: string }).name).toBe('needs-human');
  });
});
