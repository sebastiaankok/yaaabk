import { describe, expect, it } from 'vitest';
import { createOpenRouterMeter, createReporter } from './adapters';
import type { AgentConfig } from './config';

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
