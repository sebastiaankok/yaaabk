import { describe, expect, it } from 'vitest';
import { OpenRouterApiError } from './errors';
import { createOpenRouterApi } from './openrouter-http';

const MANAGEMENT_KEY = 'sk-or-management-test';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

/** Captures each request and replays queued responses in order. */
function recordingFetch(responses: Response[]): { calls: RecordedCall[]; fetch: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('no queued response');
    }
    return response;
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const KEY_DATA = {
  hash: 'abc123',
  name: 'yaaabk-issue-issue-1',
  disabled: false,
  limit: 0.5,
  limit_remaining: 0.4,
  limit_reset: null,
  usage: 0.1,
  expires_at: '2026-12-13T09:00:00.000Z',
  created_at: '2026-11-13T09:00:00.000Z',
};

describe('createOpenRouterApi', () => {
  it('creates a key through POST /keys with the management key and maps the response', async () => {
    const { calls, fetch } = recordingFetch([
      jsonResponse(
        {
          key: 'sk-or-v1-new',
          data: KEY_DATA,
        },
        201,
      ),
    ]);
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch });

    const created = await api.createKey({
      name: 'yaaabk-issue-issue-1',
      limitUsd: 0.5,
      limitReset: null,
      expiresAt: '2026-12-13T09:00:00.000Z',
    });

    expect(calls[0]).toEqual({
      url: 'https://openrouter.ai/api/v1/keys',
      method: 'POST',
      authorization: `Bearer ${MANAGEMENT_KEY}`,
      body: {
        name: 'yaaabk-issue-issue-1',
        limit: 0.5,
        limit_reset: null,
        expires_at: '2026-12-13T09:00:00.000Z',
      },
    });
    expect(created).toEqual({
      key: 'sk-or-v1-new',
      keyInfo: {
        hash: 'abc123',
        name: 'yaaabk-issue-issue-1',
        disabled: false,
        limitUsd: 0.5,
        limitRemainingUsd: 0.4,
        usageUsd: 0.1,
        expiresAt: '2026-12-13T09:00:00.000Z',
        createdAt: '2026-11-13T09:00:00.000Z',
      },
    });
  });

  it('updates a key through PATCH /keys/{hash}', async () => {
    const { calls, fetch } = recordingFetch([jsonResponse({ data: KEY_DATA })]);
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch });

    const updated = await api.updateKey('abc123', { limitUsd: 3 });

    expect(calls[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/keys/abc123',
      method: 'PATCH',
      body: { limit: 3 },
    });
    expect(updated.limitUsd).toBe(0.5);
  });

  it('reads a key through GET /keys/{hash}', async () => {
    const { calls, fetch } = recordingFetch([jsonResponse({ data: KEY_DATA })]);
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch });

    const key = await api.getKey('abc123');

    expect(calls[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/keys/abc123',
      method: 'GET',
    });
    expect(key.hash).toBe('abc123');
  });

  it('deletes a key through DELETE /keys/{hash}', async () => {
    const { calls, fetch } = recordingFetch([new Response(null, { status: 204 })]);
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch });

    await api.deleteKey('abc123');

    expect(calls[0]).toMatchObject({
      url: 'https://openrouter.ai/api/v1/keys/abc123',
      method: 'DELETE',
    });
  });

  it('reports a rejected request as an OpenRouterApiError with its status', async () => {
    const { fetch } = recordingFetch([
      jsonResponse(
        { error: { code: 403, message: 'Only management keys can perform this operation' } },
        403,
      ),
    ]);
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch });

    const error = await api.getKey('abc123').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OpenRouterApiError);
    expect(error).toMatchObject({
      statusCode: 403,
      message: 'Only management keys can perform this operation',
    });
  });

  it('reports a transport failure as a network error', async () => {
    const fetchImpl = (() => Promise.reject(new Error('connection refused'))) as typeof fetch;
    const api = createOpenRouterApi({ managementKey: MANAGEMENT_KEY, fetch: fetchImpl });

    const error = await api.getKey('abc123').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OpenRouterApiError);
    expect(error).toMatchObject({ network: true, message: 'connection refused' });
  });
});
