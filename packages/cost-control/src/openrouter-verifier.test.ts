import { describe, expect, it } from 'vitest';
import { createOpenRouterVerifier } from './openrouter-verifier';

function jsonFetch(status: number, body: unknown, statusText = ''): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('createOpenRouterVerifier', () => {
  it('reports the workspace and key count for a valid management key', async () => {
    const verifier = createOpenRouterVerifier({
      fetch: jsonFetch(200, {
        data: [
          { workspace_id: 'ws-1', hash: 'a' },
          { workspace_id: 'ws-1', hash: 'b' },
        ],
      }),
    });

    const result = await verifier.verify('sk-or-mgmt-123');

    expect(result).toEqual({ ok: true, value: { workspaceId: 'ws-1', keys: 2 } });
  });

  it('reports unauthorized when the management key is rejected', async () => {
    const verifier = createOpenRouterVerifier({
      fetch: jsonFetch(401, { error: { message: 'Invalid management key' } }),
    });

    const result = await verifier.verify('sk-or-mgmt-bad');

    expect(result).toEqual({ ok: false, kind: 'unauthorized', message: 'Invalid management key' });
  });
});
