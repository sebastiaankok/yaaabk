import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubCredentialVerifier } from './credential-verifier';

const APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey.toString();

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
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
      authorization: headers.get('authorization') ?? undefined,
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

describe('createGitHubCredentialVerifier', () => {
  it('resolves a PAT to the account it belongs to', async () => {
    const { fetch, requests } = recordingFetch([{ status: 200, body: { login: 'octocat' } }]);
    const verifier = createGitHubCredentialVerifier({ fetch });

    const result = await verifier.verifyWithPat('ghp_testtoken');

    expect(result).toEqual({ ok: true, value: { kind: 'pat', account: 'octocat' } });
    expect(requests[0]?.url).toBe('https://api.github.com/user');
    expect(requests[0]?.authorization).toBe('Bearer ghp_testtoken');
  });

  it('resolves an App installation to the account it is installed on', async () => {
    const { fetch, requests } = recordingFetch([
      { status: 200, body: { account: { login: 'acme-org' } } },
    ]);
    const verifier = createGitHubCredentialVerifier({ fetch });

    const result = await verifier.verifyWithApp({
      appId: '12345',
      privateKey: APP_PRIVATE_KEY,
      installationId: '67890',
    });

    expect(result).toEqual({ ok: true, value: { kind: 'app', account: 'acme-org' } });
    expect(requests[0]?.authorization?.split('.')).toHaveLength(3);
    expect(requests[0]?.url).toContain('/app/installations/67890');
  });

  it('resolves an App without an installation to the app slug', async () => {
    const { fetch, requests } = recordingFetch([{ status: 200, body: { slug: 'yaaabk-app' } }]);
    const verifier = createGitHubCredentialVerifier({ fetch });

    const result = await verifier.verifyWithApp({ appId: '12345', privateKey: APP_PRIVATE_KEY });

    expect(result).toEqual({ ok: true, value: { kind: 'app', account: 'yaaabk-app' } });
    expect(requests[0]?.url).toContain('/app');
  });

  it('reports unauthorized when GitHub rejects a PAT', async () => {
    const { fetch } = recordingFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const verifier = createGitHubCredentialVerifier({ fetch });

    const result = await verifier.verifyWithPat('ghp_expired');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unauthorized');
    }
  });
});
