import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn } from './test-support';

async function request(
  context: ReturnType<typeof createTestContext>,
  path: string,
  session?: string,
): Promise<Response> {
  return context.app.request(path, {
    headers:
      session === undefined
        ? {}
        : { cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
  });
}

describe('GET /api/models', () => {
  it('returns the tool-capable catalogue and the environment default', async () => {
    const context = createTestContext();
    const session = await signIn(context);
    context.models.set([
      {
        id: 'openrouter/anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        contextLength: 200000,
        promptUsdPerMillion: 3,
        completionUsdPerMillion: 15,
      },
    ]);

    const response = await request(context, '/api/models', session);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [
        {
          id: 'openrouter/anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          contextLength: 200000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 15,
        },
      ],
      defaultModel: 'openrouter/default-model',
    });
  });

  it('requires the Developer session', async () => {
    const context = createTestContext();

    const response = await request(context, '/api/models');

    expect(response.status).toBe(401);
    expect(context.models.calls).toBe(0);
  });

  it('reports an unavailable catalogue without failing the request silently', async () => {
    const context = createTestContext();
    const session = await signIn(context);
    context.models.fail('OpenRouter is unavailable');

    const response = await request(context, '/api/models', session);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'server',
      message: 'OpenRouter is unavailable',
    });
  });
});
