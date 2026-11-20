import { describe, expect, it } from 'vitest';
import { createGitHubContentsClient } from './github-contents-client';

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function contentFile(content: string, sha = 'blob-1') {
  return {
    type: 'file',
    path: 'docs/plans/v1.md',
    sha,
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
}

function client(fetchImpl: typeof fetch) {
  return createGitHubContentsClient({ token: 'gh-token', fetch: fetchImpl });
}

describe('createGitHubContentsClient', () => {
  it('reads a file and reports a missing one as absent', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json(contentFile('# Plan v1\n')),
      json({ message: 'Not Found' }, 404),
    ]);
    const contents = client(fetchImpl);

    const found = await contents.readFile('acme/todo-app', 'docs/plans/v1.md');
    const missing = await contents.readFile('acme/todo-app', 'docs/plans/v2.md');

    expect(found).toEqual({
      ok: true,
      value: { path: 'docs/plans/v1.md', sha: 'blob-1', content: '# Plan v1\n' },
    });
    expect(missing).toEqual({ ok: true, value: null });
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/acme/todo-app/contents/docs/plans/v2.md',
    );
  });

  it('creates a file that does not exist yet', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json({ message: 'Not Found' }, 404),
      json({ content: { sha: 'new-sha' }, commit: { sha: 'commit-1' } }, 201),
    ]);

    const result = await client(fetchImpl).writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'docs: record accepted Plan v1 [skip ci]',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('created');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.github.com/repos/acme/todo-app/contents/docs/plans/v1.md',
    });
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      url: 'https://api.github.com/repos/acme/todo-app/contents/docs/plans/v1.md',
    });
    expect(calls[1]?.body).toMatchObject({
      message: 'docs: record accepted Plan v1 [skip ci]',
      content: Buffer.from('# Plan v1\n', 'utf8').toString('base64'),
    });
    expect(calls[1]?.body).not.toHaveProperty('sha');
  });

  it('skips the commit when the file already has identical content', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([json(contentFile('# Plan v1\n'))]);

    const result = await client(fetchImpl).writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\n',
      message: 'docs: record accepted Plan v1 [skip ci]',
    });

    expect(result).toEqual({ ok: true, value: { status: 'unchanged', sha: 'blob-1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('updates an existing file with its current SHA', async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      json(contentFile('# Plan v1\nOld\n', 'old-sha')),
      json({ content: { sha: 'new-sha' } }, 200),
    ]);

    const result = await client(fetchImpl).writeFile('acme/todo-app', 'docs/plans/v1.md', {
      content: '# Plan v1\nNew\n',
      message: 'docs: record accepted Plan v1 [skip ci]',
    });

    expect(result).toEqual({ ok: true, value: { status: 'updated', sha: 'new-sha' } });
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.body).toMatchObject({
      sha: 'old-sha',
      content: Buffer.from('# Plan v1\nNew\n', 'utf8').toString('base64'),
    });
  });
});
