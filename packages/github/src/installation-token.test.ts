import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInstallationTokenProvider } from './installation-token';

const APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey.toString();

/** The format GitHub actually downloads: PKCS#1, not PKCS#8. */
const GITHUB_DOWNLOADED_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey.toString();

interface RecordedRequest {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body: string | undefined;
}

function recordingFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const response = responses[call];
    call += 1;
    return new Response(JSON.stringify(response?.body ?? {}), {
      status: response?.status ?? 500,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe('createInstallationTokenProvider', () => {
  it('mints an installation token with an App JWT', async () => {
    const { fetch, requests } = recordingFetch([
      {
        status: 201,
        body: { token: 'ghs_installation_token', expires_at: '2026-01-01T01:00:00Z' },
      },
    ]);
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
      fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const token = await provider.token();

    expect(token).toBe('ghs_installation_token');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.github.com/app/installations/67890/access_tokens');
    expect(requests[0]!.method).toBe('POST');
    // The App JWT identifies the app, not the installation.
    expect(requests[0]!.authorization).toMatch(/^Bearer /);
  });

  it('mints a token from the PKCS#1 key GitHub downloads', async () => {
    const { fetch, requests } = recordingFetch([
      {
        status: 201,
        body: { token: 'ghs_installation_token', expires_at: '2026-01-01T01:00:00Z' },
      },
    ]);
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: GITHUB_DOWNLOADED_KEY,
      installationId: '67890',
      fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const token = await provider.token();

    expect(token).toBe('ghs_installation_token');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toMatch(/^Bearer /);
  });

  it('caches the token until it nears expiry', async () => {
    const responses: Array<{ status: number; body: unknown }> = [
      { status: 201, body: { token: 'ghs_first', expires_at: '2026-01-01T01:00:00Z' } },
      { status: 201, body: { token: 'ghs_second', expires_at: '2026-01-01T02:00:00Z' } },
    ];
    const { fetch, requests } = recordingFetch(responses);
    let moment = new Date('2026-01-01T00:00:00Z');
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
      fetch,
      now: () => moment,
    });

    const first = await provider.token();
    moment = new Date('2026-01-01T00:30:00Z');
    const second = await provider.token();

    expect(second).toBe(first);
    expect(requests).toHaveLength(1);

    // A token nearing its expiry must never be reused: five minutes before it
    // dies a fresh one is minted.
    moment = new Date('2026-01-01T00:56:00Z');
    const third = await provider.token();
    expect(third).not.toBe(first);
    expect(requests).toHaveLength(2);
    // The JWT holder (not the installation) is asked for the new token.
    expect(requests[1]!.url).toBe('https://api.github.com/app/installations/67890/access_tokens');
  });

  it('sends the requested permissions when a scope is given', async () => {
    const { fetch, requests } = recordingFetch([
      {
        status: 201,
        body: { token: 'ghs_scoped', expires_at: '2026-01-01T01:00:00Z' },
      },
    ]);
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
      fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    await provider.token({ contents: 'read', pull_requests: 'write' });

    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({
      permissions: { contents: 'read', pull_requests: 'write' },
    });
  });

  it('omits permissions when no scope is given', async () => {
    const { fetch, requests } = recordingFetch([
      {
        status: 201,
        body: { token: 'ghs_global', expires_at: '2026-01-01T01:00:00Z' },
      },
    ]);
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
      fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    await provider.token();

    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({});
  });

  it('caches a token per scope', async () => {
    const responses: Array<{ status: number; body: unknown }> = [
      { status: 201, body: { token: 'ghs_review', expires_at: '2026-01-01T01:00:00Z' } },
      { status: 201, body: { token: 'ghs_implement', expires_at: '2026-01-01T01:00:00Z' } },
      { status: 201, body: { token: 'ghs_review_again', expires_at: '2026-01-01T02:00:00Z' } },
    ];
    const { fetch, requests } = recordingFetch(responses);
    const provider = createInstallationTokenProvider({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
      fetch,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });

    const review = await provider.token({ contents: 'read', pull_requests: 'write' });
    const implement = await provider.token({
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write',
    });
    const reviewAgain = await provider.token({
      pull_requests: 'write',
      contents: 'read',
    });

    expect(review).toBe('ghs_review');
    expect(implement).toBe('ghs_implement');
    // Permission order does not define identity: the same scope reuses its token.
    expect(reviewAgain).toBe(review);
    expect(requests).toHaveLength(2);
  });
});
