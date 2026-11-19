import { describe, expect, it } from 'vitest';
import { createOpenRouterCreditsReader } from './openrouter-credits';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenRouterCreditsReader', () => {
  it('reads the account balance with the management key', async () => {
    let authorization: string | null = null;
    const reader = createOpenRouterCreditsReader({
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization');
        return jsonResponse({ data: { total_credits: 40, total_usage: 39.9928 } });
      },
    });

    const result = await reader.read('sk-or-management-test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalCreditsUsd).toBe(40);
      expect(result.value.totalUsageUsd).toBe(39.9928);
      expect(result.value.remainingUsd).toBeCloseTo(0.0072, 6);
    }
    expect(authorization).toBe('Bearer sk-or-management-test');
  });

  it('reports a rejected management key as unauthorized', async () => {
    const reader = createOpenRouterCreditsReader({
      fetch: async () => jsonResponse({ error: { message: 'Invalid key' } }, 401),
    });

    const result = await reader.read('sk-or-management-test');

    expect(result).toEqual({ ok: false, kind: 'unauthorized', message: 'Invalid key' });
  });

  it('reports a transport failure as a network error', async () => {
    const reader = createOpenRouterCreditsReader({
      fetch: async () => {
        throw new Error('connection refused');
      },
    });

    const result = await reader.read('sk-or-management-test');

    expect(result).toMatchObject({ ok: false, kind: 'network', message: 'connection refused' });
  });

  it('reports a server failure as a server error', async () => {
    const reader = createOpenRouterCreditsReader({
      fetch: async () => jsonResponse({ error: { message: 'upstream unavailable' } }, 503),
    });

    const result = await reader.read('sk-or-management-test');

    expect(result).toMatchObject({ ok: false, kind: 'server', message: 'upstream unavailable' });
  });
});
