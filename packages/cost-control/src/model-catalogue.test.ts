import { describe, expect, it, vi } from 'vitest';
import { MODEL_CACHE_TTL_MS, createOpenRouterModelCatalogue } from './model-catalogue';

const MODELS = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['temperature', 'tools'],
    },
    {
      id: 'google/gemini-image',
      name: 'Gemini Image',
      context_length: 32000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      architecture: { output_modalities: ['image'] },
      supported_parameters: ['tools'],
    },
    {
      id: 'acme/plain-chat',
      name: 'Plain chat',
      context_length: 8000,
      pricing: { prompt: '0.000001', completion: '0.000001' },
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['temperature'],
    },
  ],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenRouter model catalogue', () => {
  it('returns tool-capable text models in OpenCode model form', async () => {
    const fetch = vi.fn(async () => response(MODELS));
    const catalogue = createOpenRouterModelCatalogue({ fetch });

    const result = await catalogue.list();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        id: 'openrouter/anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        contextLength: 200000,
        promptUsdPerMillion: 3,
        completionUsdPerMillion: 15,
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('serves a cached catalogue within the TTL and refetches after it', async () => {
    let now = new Date('2026-01-01T12:00:00.000Z');
    const fetch = vi.fn(async () => response(MODELS));
    const catalogue = createOpenRouterModelCatalogue({ fetch, now: () => now });

    await catalogue.list();
    await catalogue.list();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + MODEL_CACHE_TTL_MS);
    await catalogue.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const fetch = vi.fn(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(response(MODELS)), 5)),
    );
    const catalogue = createOpenRouterModelCatalogue({ fetch });

    const [first, second] = await Promise.all([catalogue.list(), catalogue.list()]);

    expect(first.ok && second.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports an upstream failure without caching it', async () => {
    const fetch = vi.fn(async () => response({ error: { message: 'nope' } }, 500));
    const catalogue = createOpenRouterModelCatalogue({ fetch });

    const result = await catalogue.list();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server');
      expect(result.error.message).toBe('nope');
    }

    await catalogue.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an unexpected payload', async () => {
    const catalogue = createOpenRouterModelCatalogue({
      fetch: vi.fn(async () => response({ models: [] })),
    });

    const result = await catalogue.list();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('server');
  });
});
