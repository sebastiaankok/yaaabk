import { describe, expect, it, vi } from 'vitest';
import { ReportClientError, createReportClient } from './client';

const STATUS = {
  id: 'session-1',
  status: 'active',
  draft: { hasPrd: true, issueCount: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createReportClient', () => {
  it('posts a report with the session bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(STATUS));
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      fetch: fetchMock,
    });

    const status = await client.report({ prd: '# Plan (PRD)', summary: 'A plan.' });

    expect(status.draft.hasPrd).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.internal:3000/api/grill-sessions/session-1/report',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ prd: '# Plan (PRD)', summary: 'A plan.' }),
      }),
    );
  });

  it('reads the session status with the same token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(STATUS));
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      fetch: fetchMock,
    });

    await client.status();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.internal:3000/api/grill-sessions/session-1/status',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('turns a backend rejection into a typed error carrying its message', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'invalid-input', message: 'Report a PRD before its issues' }, 400),
    );
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      fetch: fetchMock,
    });

    await expect(client.report({ issues: [] })).rejects.toMatchObject({
      name: 'ReportClientError',
      status: 400,
      message: 'Report a PRD before its issues',
    });
  });

  it('carries the HTTP status when the body is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream down', { status: 502 }));
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      fetch: fetchMock,
    });

    const failure = await client.status().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReportClientError);
    if (failure instanceof ReportClientError) {
      expect(failure.status).toBe(502);
      expect(failure.message).toContain('502');
    }
  });

  it('names the unreachable URL instead of surfacing a bare transport error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Unable to connect');
    });
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      fetch: fetchMock,
    });

    const failure = await client.report({ prd: '# Plan (PRD)' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReportClientError);
    if (failure instanceof ReportClientError) {
      expect(failure.message).toContain(
        'http://backend.internal:3000/api/grill-sessions/session-1/report',
      );
      expect(failure.message).toContain('Retrying is safe');
    }
  });

  it('gives up on a hanging connection after the timeout', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const client = createReportClient({
      apiUrl: 'http://backend.internal:3000',
      sessionId: 'session-1',
      token: 'secret-token',
      timeoutMs: 10,
      fetch: hanging,
    });

    const failure = await client.report({ prd: '# Plan (PRD)' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReportClientError);
    if (failure instanceof ReportClientError) {
      expect(failure.message).toContain('did not respond within 10 ms');
    }
  });
});
