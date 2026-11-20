import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoundedOutput,
  checksForScripts,
  createChecks,
  createGitHub,
  createOpenCode,
  createOpenRouterMeter,
  createRegistry,
  createReporter,
  newOpenCodeSessionId,
  openCodeSpawn,
  parseExportedSessionTokens,
  parseImage,
  reviewVerdictPath,
} from './adapters';
import type { AgentConfig } from './config';

const TOKENS = {
  input: 1_200,
  output: 300,
  reasoning: 40,
  cache: { read: 5_000, write: 10 },
};

const CONFIG: AgentConfig = {
  kind: 'implement-issue',
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: 'sk-or-key',
  maxAttempts: 3,
};

/** A fetch stub that records its calls and returns a queued response. */
function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetch: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

describe('createOpenCode', () => {
  /** Records the command OpenCode would have been spawned with. */
  function recordingRunner(result: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
    const requests: Array<{ directory: string; args: string[] }> = [];
    return {
      requests,
      run: async (request: { directory: string; args: string[] }) => {
        requests.push(request);
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? 'done',
          ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
        };
      },
    };
  }

  /** An export reader that records the sessions it was asked to export. */
  function recordingExport(tokens: unknown = TOKENS) {
    const sessions: string[] = [];
    return {
      sessions,
      exportSession: async ({ sessionId }: { sessionId: string }) => {
        sessions.push(sessionId);
        return { exitCode: 0, stdout: JSON.stringify({ info: { tokens } }) };
      },
    };
  }

  it('runs OpenCode in a fresh session and records the exported tokens', async () => {
    const runner = recordingRunner();
    const exporter = recordingExport();

    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run: runner.run,
        exportSession: exporter.exportSession,
        newSessionId: () => 'ses_first',
      },
    );
    const result = await openCode.implement({
      directory: '/work/repo',
      prompt: 'Implement issue #42',
    });

    expect(runner.requests).toEqual([
      {
        directory: '/work/repo',
        args: [
          'run',
          '--model',
          'openrouter/chosen',
          '--auto',
          '--session',
          'ses_first',
          'Implement issue #42',
        ],
      },
    ]);
    expect(exporter.sessions).toEqual(['ses_first']);
    expect(result).toEqual({ exitCode: 0, output: 'done', tokens: TOKENS });
  });

  it('keeps stderr so a provider error is not an empty run log', async () => {
    const runner = recordingRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: This request requires more credits',
    });

    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      { run: runner.run, exportSession: recordingExport().exportSession },
    );
    const result = await openCode.implement({
      directory: '/work/repo',
      prompt: 'Implement issue #42',
    });

    expect(result).toEqual({
      exitCode: 1,
      output: 'Error: This request requires more credits',
      tokens: TOKENS,
    });
  });

  it('retries with fresh sessions and sums what each attempt used', async () => {
    const queued = [
      { exitCode: 1, stdout: '', stderr: 'Error: Model unavailable: openrouter/chosen' },
      { exitCode: 1, stdout: '', stderr: 'Error: Model unavailable: openrouter/chosen' },
      { exitCode: 0, stdout: 'done' },
    ];
    const requests: Array<{ directory: string; args: string[] }> = [];
    const run = async (request: { directory: string; args: string[] }) => {
      requests.push(request);
      const next = queued.shift();
      if (next === undefined) throw new Error('unexpected extra invocation');
      return next;
    };
    const sessionIds = ['ses_1', 'ses_2', 'ses_3'];
    const exported: string[] = [];
    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run,
        retryDelaysMs: [0, 0, 0],
        newSessionId: () => sessionIds.shift() ?? 'ses_extra',
        exportSession: async ({ sessionId }) => {
          exported.push(sessionId);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              info: {
                tokens: {
                  input: 10,
                  output: 1,
                  reasoning: 0,
                  cache: { read: 100, write: 0 },
                },
              },
            }),
          };
        },
      },
    );
    const result = await openCode.implement({ directory: '/work/repo', prompt: 'Implement #42' });

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.args[request.args.indexOf('--session') + 1])).toEqual([
      'ses_1',
      'ses_2',
      'ses_3',
    ]);
    expect(exported).toEqual(['ses_1', 'ses_2', 'ses_3']);
    expect(result).toEqual({
      exitCode: 0,
      output: 'done',
      tokens: {
        input: 30,
        output: 3,
        reasoning: 0,
        cache: { read: 300, write: 0 },
      },
    });
  });

  it('reports no tokens when no retry could be measured', async () => {
    const queued = [
      { exitCode: 1, stdout: '', stderr: 'Error: Model unavailable: openrouter/chosen' },
      { exitCode: 0, stdout: 'done' },
    ];
    const run = async () => queued.shift() ?? { exitCode: 0, stdout: 'done' };
    let exports = 0;
    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run,
        retryDelaysMs: [0],
        newSessionId: () => `ses_${++exports}`,
        exportSession: async () => ({ exitCode: 1, stdout: 'export failed' }),
      },
    );

    const result = await openCode.implement({ directory: '/work/repo', prompt: 'Implement #42' });

    expect(exports).toBe(2);
    expect(result.tokens).toBeNull();
  });

  it('does not retry a failure that is not the model catalogue', async () => {
    const runner = recordingRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: This request requires more credits',
    });

    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run: runner.run,
        retryDelaysMs: [0, 0],
        exportSession: recordingExport().exportSession,
      },
    );
    const result = await openCode.implement({ directory: '/work/repo', prompt: 'Implement #42' });

    expect(runner.requests).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('reports the failure once every retry is exhausted', async () => {
    const runner = recordingRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Model unavailable: openrouter/chosen',
    });

    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run: runner.run,
        retryDelaysMs: [0, 0],
        exportSession: recordingExport().exportSession,
      },
    );
    const result = await openCode.implement({ directory: '/work/repo', prompt: 'Implement #42' });

    expect(runner.requests).toHaveLength(3);
    expect(result).toEqual({
      exitCode: 1,
      output: 'Error: Model unavailable: openrouter/chosen',
      tokens: {
        input: 3_600,
        output: 900,
        reasoning: 120,
        cache: { read: 15_000, write: 30 },
      },
    });
  });

  it('runs a review with the same explicit model and automatic approvals', async () => {
    const runner = recordingRunner();
    const verdict = { event: 'approve' as const, body: 'Looks good.' };

    const openCode = createOpenCode(
      { model: 'openrouter/chosen' },
      {
        run: runner.run,
        readVerdict: async () => verdict,
        exportSession: recordingExport().exportSession,
        newSessionId: () => 'ses_review',
      },
    );
    const result = await openCode.review({
      directory: '/work/repo',
      prompt: 'Review pull request #7',
    });

    expect(runner.requests).toEqual([
      {
        directory: '/work/repo',
        args: [
          'run',
          '--model',
          'openrouter/chosen',
          '--auto',
          '--session',
          'ses_review',
          'Review pull request #7',
        ],
      },
    ]);
    expect(result).toEqual({ exitCode: 0, output: 'done', verdict, tokens: TOKENS });
  });

  it('refuses to run without a configured model', async () => {
    const openCode = createOpenCode(
      {},
      { run: recordingRunner().run, exportSession: recordingExport().exportSession },
    );

    await expect(
      openCode.implement({ directory: '/work/repo', prompt: 'Implement issue #42' }),
    ).rejects.toThrow(/AGENT_MODEL/);
  });
});

describe('openCodeSpawn', () => {
  it('runs OpenCode in the checkout and points PWD there too', () => {
    const spawned = openCodeSpawn('/work/repo', ['run', 'Implement issue #42'], {
      PWD: '/app',
      HOME: '/home/bun',
    });

    expect(spawned.cmd).toEqual(['opencode', 'run', 'Implement issue #42']);
    expect(spawned.options.cwd).toBe('/work/repo');
    // OpenCode resolves its project from PWD, so a stale /app would make every
    // shell command run in the harness instead of the checkout.
    expect(spawned.options.env).toMatchObject({ PWD: '/work/repo', HOME: '/home/bun' });
  });

  it('reads the review verdict from the checkout path the prompt names', () => {
    expect(reviewVerdictPath('/work/repo')).toBe('/work/repo/.yaaabk/review.json');
  });
});

describe('parseExportedSessionTokens', () => {
  it('reads the five token components from an exported session', () => {
    const exported = JSON.stringify({
      info: { id: 'ses_1', tokens: TOKENS },
      messages: [],
    });

    expect(parseExportedSessionTokens(exported)).toEqual(TOKENS);
  });

  it('returns null for a malformed, partial or unreadable export', () => {
    expect(parseExportedSessionTokens('not json')).toBeNull();
    expect(parseExportedSessionTokens(JSON.stringify({ info: {} }))).toBeNull();
    expect(
      parseExportedSessionTokens(JSON.stringify({ info: { tokens: { input: 1 } } })),
    ).toBeNull();
  });
});

describe('newOpenCodeSessionId', () => {
  it('generates a fresh id in the form OpenCode accepts', () => {
    const first = newOpenCodeSessionId();
    const second = newOpenCodeSessionId();

    expect(first).toMatch(/^ses_[0-9a-f]+$/);
    expect(second).not.toBe(first);
  });
});

describe('createOpenRouterMeter', () => {
  it('reads the run key usage in USD from OpenRouter', async () => {
    const { calls, fetch } = stubFetch(
      () => new Response(JSON.stringify({ data: { usage: 1.25 } }), { status: 200 }),
    );
    const meter = createOpenRouterMeter(
      { ...CONFIG, openrouterBaseUrl: 'https://or.test/api/v1' },
      {
        fetch,
      },
    );

    await expect(meter.usageUsd()).resolves.toBe(1.25);
    expect(calls[0]?.url).toBe('https://or.test/api/v1/key');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-or-key',
    );
  });

  it('yields undefined when OpenRouter rejects the request', async () => {
    const { fetch } = stubFetch(() => new Response('nope', { status: 401 }));
    const meter = createOpenRouterMeter(CONFIG, { fetch });

    await expect(meter.usageUsd()).resolves.toBeUndefined();
  });

  it('yields undefined when the key has no usage field', async () => {
    const { fetch } = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const meter = createOpenRouterMeter(CONFIG, { fetch });

    await expect(meter.usageUsd()).resolves.toBeUndefined();
  });

  it('yields undefined when the request throws', async () => {
    const meter = createOpenRouterMeter(CONFIG, {
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });

    await expect(meter.usageUsd()).resolves.toBeUndefined();
  });
});

describe('createReporter', () => {
  it('includes costCents in the report body when the run reports spend', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      {
        ...CONFIG,
        apiUrl: 'https://api.test',
        runId: 'run-1',
        runToken: 'run-token',
      },
      { fetch },
    );

    await reporter.report({
      prUrl: 'https://github.com/acme/todo-app/pull/7',
      logs: 'done',
      costCents: 25,
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ token: 'run-token', costCents: 25 });
  });

  it('includes token usage in the report body when the run measured it', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      { ...CONFIG, apiUrl: 'https://api.test', runId: 'run-1', runToken: 'run-token' },
      { fetch },
    );

    await reporter.report({ prUrl: null, logs: 'done', tokens: TOKENS });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ token: 'run-token', tokens: TOKENS });
  });

  it('omits token usage from the report body when no attempt could be measured', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      { ...CONFIG, apiUrl: 'https://api.test', runId: 'run-1', runToken: 'run-token' },
      { fetch },
    );

    await reporter.report({ prUrl: null, logs: 'done' });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tokens');
  });

  it('includes commitSha in the report body when the deploy run reports the deployed SHA', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      {
        ...CONFIG,
        apiUrl: 'https://api.test',
        runId: 'run-1',
        runToken: 'run-token',
      },
      { fetch },
    );

    await reporter.report({
      prUrl: null,
      logs: 'deployed',
      commitSha: 'sha-abc123',
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ token: 'run-token', commitSha: 'sha-abc123' });
  });

  it('includes deployOutcome in the report body when the deploy run reports one', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      {
        ...CONFIG,
        apiUrl: 'https://api.test',
        runId: 'run-1',
        runToken: 'run-token',
      },
      { fetch },
    );

    await reporter.report({
      prUrl: null,
      logs: 'deployed',
      commitSha: 'sha-abc123',
      deployOutcome: 'failed',
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ token: 'run-token', deployOutcome: 'failed' });
  });

  it('omits costCents from the report body when spend is unmeasured', async () => {
    const { calls, fetch } = stubFetch(() => new Response('{}', { status: 200 }));
    const reporter = createReporter(
      { ...CONFIG, apiUrl: 'https://api.test', runId: 'run-1', runToken: 'run-token' },
      { fetch },
    );

    await reporter.report({ prUrl: null, logs: 'done' });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('costCents');
  });
});

describe('BoundedOutput', () => {
  const encoder = new TextEncoder();

  it('keeps only the tail, so a long run cannot grow without bound', () => {
    const output = new BoundedOutput(10);
    output.append(encoder.encode('0123456789'));
    output.append(encoder.encode('abc'));

    expect(output.text()).toBe('3456789abc');
  });

  it('trims a single chunk larger than the limit', () => {
    const output = new BoundedOutput(4);
    output.append(encoder.encode('abcdefgh'));

    expect(output.text()).toBe('efgh');
  });
});

describe('createGitHub createReview', () => {
  it('carries the verdict in a comment review when GitHub refuses a self-review', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const responses = [
      new Response(
        JSON.stringify({
          message: 'Unprocessable Entity',
          errors: ['Review Can not request changes on your own pull request'],
        }),
        { status: 422 },
      ),
      new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    ];
    const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift()!;
    }) as unknown as typeof fetch;

    const github = createGitHub(CONFIG, { fetch: fetchStub });
    await github.createReview({ pullNumber: 5, event: 'request-changes', body: 'Fix the API.' });

    expect(bodies.map((body) => body['event'])).toEqual(['REQUEST_CHANGES', 'COMMENT']);
    expect(bodies[1]?.['body']).toContain('yaaabk-verdict: request-changes');
    expect(bodies[1]?.['body']).toContain('Fix the API.');
  });
});

describe('createGitHub openPullRequest', () => {
  it('reuses the open pull request when a fix run pushes to its branch', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const responses = [
      new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 }),
      new Response(
        JSON.stringify([{ number: 5, html_url: 'https://github.com/acme/todo-app/pull/5' }]),
        { status: 200 },
      ),
      new Response(JSON.stringify({}), { status: 200 }),
    ];
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      });
      return responses.shift()!;
    }) as unknown as typeof fetch;

    const github = createGitHub(CONFIG, { fetch: fetchStub });
    const pull = await github.openPullRequest({
      branch: 'agent/issue-42',
      title: 'Add login',
      body: 'Implements #42.',
      labels: ['automerge'],
    });

    expect(pull).toEqual({ number: 5, url: 'https://github.com/acme/todo-app/pull/5' });
    expect(calls[1]?.url).toContain('/pulls?state=open&head=acme%3Aagent%2Fissue-42');
    // The label is still applied, so automerge is set on a reused pull request.
    expect(calls[2]?.url).toContain('/issues/5/labels');
  });
});

describe('checksForScripts', () => {
  it('prefers a project-defined check script', () => {
    expect(checksForScripts({ check: 'bun run lint && bun test', lint: 'x', test: 'y' })).toEqual([
      { script: 'run', args: ['check'] },
    ]);
  });

  it('falls back to lint, typecheck and test', () => {
    expect(checksForScripts({ lint: 'x', typecheck: 'y', test: 'z' })).toEqual([
      { script: 'run', args: ['lint'] },
      { script: 'run', args: ['typecheck'] },
      { script: 'run', args: ['test'] },
    ]);
  });

  it('uses test:unit when a project has no test script', () => {
    expect(checksForScripts({ 'test:unit': 'bun test' })).toEqual([
      { script: 'run', args: ['test:unit'] },
    ]);
  });
});

describe('createChecks', () => {
  it('installs from the lockfile and runs the project check script', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yaaabk-checks-'));
    try {
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ scripts: { check: 'bun run lint && bun test' } }),
      );
      const calls: string[] = [];
      const checks = createChecks({
        now: () => 0,
        run: async (_directory, script, args) => {
          calls.push(`${script} ${args.join(' ')}`);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      const result = await checks.run(directory);

      expect(result.passed).toBe(true);
      expect(calls).toEqual(['install --frozen-lockfile --prefer-offline', 'run check']);
      expect(result.output).toContain('bun install --frozen-lockfile');
      expect(result.output).toContain('bun run check');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('installs once more without the frozen lockfile when it is stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yaaabk-checks-'));
    try {
      await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
      const calls: string[] = [];
      const checks = createChecks({
        now: () => 0,
        run: async (_directory, script, args) => {
          calls.push(`${script} ${args.join(' ')}`);
          if (calls.length === 1) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'error: lockfile had changes, but lockfile is frozen',
            };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      const result = await checks.run(directory);

      expect(result.passed).toBe(true);
      expect(calls).toEqual([
        'install --frozen-lockfile --prefer-offline',
        'install --prefer-offline',
        'run test',
      ]);
      expect(result.output).toContain('installing without --frozen-lockfile');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('parseImage', () => {
  it('splits a tagged image reference', () => {
    expect(parseImage('ghcr.io/acme/todo-app:abc123')).toEqual({
      registry: 'ghcr.io',
      repository: 'acme/todo-app',
      tag: 'abc123',
    });
  });

  it('defaults a missing tag to latest', () => {
    expect(parseImage('ghcr.io/acme/todo-app')).toEqual({
      registry: 'ghcr.io',
      repository: 'acme/todo-app',
      tag: 'latest',
    });
  });
});

describe('createRegistry', () => {
  it('waits until the image tag resolves', async () => {
    const requests: string[] = [];
    let manifests = 0;
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'pull-token' }), { status: 200 });
      }
      manifests += 1;
      return new Response('', { status: manifests === 1 ? 404 : 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const registry = createRegistry({
      fetch: fetchStub,
      pollMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await registry.waitForImage({ image: 'ghcr.io/acme/todo-app:abc123' });

    expect(manifests).toBe(2);
    expect(sleeps).toEqual([25]);
    expect(requests[0]).toContain('scope=repository%3Aacme%2Ftodo-app%3Apull');
    expect(requests[1]).toContain('HEAD https://ghcr.io/v2/acme/todo-app/manifests/abc123');
  });

  it('rejects with the image name when the tag never appears', async () => {
    const registry = createRegistry({
      fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      pollMs: 0,
      sleep: async () => {},
    });

    await expect(
      registry.waitForImage({ image: 'ghcr.io/acme/todo-app:missing', timeoutMs: 0 }),
    ).rejects.toThrow('Image ghcr.io/acme/todo-app:missing was not published');
  });
});
