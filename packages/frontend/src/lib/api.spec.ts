import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStatus, login } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getStatus', () => {
  it('returns the parsed status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ setupComplete: true, authenticated: false })),
    );

    await expect(getStatus()).resolves.toEqual({ setupComplete: true, authenticated: false });
  });
});

describe('failed requests', () => {
  it('throws a typed ApiError carrying the backend code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: 'invalid-credentials', message: 'Incorrect username or password' },
          401,
        ),
      ),
    );

    await expect(login({ username: 'alice', password: 'nope' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'invalid-credentials',
      message: 'Incorrect username or password',
    });
  });
});

describe('request options', () => {
  it('posts JSON with cookies attached', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await login({ username: 'alice', password: 'secret' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/login$/),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
