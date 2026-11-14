import { importPKCS8, SignJWT } from 'jose';

/** How the verified credentials authenticate; mirrors the Settings Module's port. */
export type GitHubCredentialKind = 'pat' | 'app';

/** The result of verifying GitHub credentials, matching the Settings port. */
export type GitHubVerifyResult =
  | { ok: true; value: { kind: GitHubCredentialKind; account: string } }
  | { ok: false; kind: 'unauthorized' | 'network' | 'server'; message: string };

export interface GitHubCredentialVerifierOptions {
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for the App JWT `iat`/`exp` claims; defaults to now. */
  now?: () => Date;
}

/**
 * Builds the verifier the Settings Module's GitHub port expects.
 *
 * A PAT is resolved with `GET /user`. A GitHub App authenticates with a short
 * RS256 JWT (the app id as the subject) and resolves either the configured
 * installation or, absent one, the app itself.
 */
export function createGitHubCredentialVerifier(options: GitHubCredentialVerifierOptions = {}): {
  verifyWithPat(pat: string): Promise<GitHubVerifyResult>;
  verifyWithApp(app: {
    appId: string;
    privateKey: string;
    installationId?: string;
  }): Promise<GitHubVerifyResult>;
} {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  async function getJson(
    path: string,
    authorization: string,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; kind: 'unauthorized' | 'network' | 'server'; message: string }
  > {
    let response: Response;
    try {
      response = await doFetch(`${apiBaseUrl}${path}`, {
        headers: {
          Authorization: authorization,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return {
        ok: false,
        kind: 'unauthorized',
        message: `GitHub rejected the credentials (${response.status})`,
      };
    }
    if (!response.ok) {
      return { ok: false, kind: 'server', message: `GitHub responded with ${response.status}` };
    }
    return { ok: true, value: (await response.json()) as unknown };
  }

  async function appToken(appId: string, privateKey: string): Promise<string> {
    const key = await importPKCS8(privateKey, 'RS256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(appId)
      .setIssuedAt(Math.floor(now().getTime() / 1000) - 60)
      .setExpirationTime(Math.floor(now().getTime() / 1000) + 600)
      .sign(key);
  }

  return {
    async verifyWithPat(pat) {
      const result = await getJson('/user', `Bearer ${pat}`);
      if (!result.ok) {
        return result;
      }
      const user = result.value as { login?: string };
      return { ok: true, value: { kind: 'pat', account: user.login ?? 'unknown' } };
    },

    async verifyWithApp({ appId, privateKey, installationId }) {
      let token: string;
      try {
        token = await appToken(appId, privateKey);
      } catch {
        return {
          ok: false,
          kind: 'unauthorized',
          message: 'The GitHub App private key could not be read',
        };
      }
      const authorization = `Bearer ${token}`;
      if (installationId !== undefined) {
        const installation = await getJson(
          `/app/installations/${encodeURIComponent(installationId)}`,
          authorization,
        );
        if (!installation.ok) {
          return installation;
        }
        const payload = installation.value as { account?: { login?: string } };
        return {
          ok: true,
          value: { kind: 'app', account: payload.account?.login ?? `app-${appId}` },
        };
      }
      const app = await getJson('/app', authorization);
      if (!app.ok) {
        return app;
      }
      const payload = app.value as { slug?: string };
      return { ok: true, value: { kind: 'app', account: payload.slug ?? `app-${appId}` } };
    },
  };
}
