import { importPKCS8, SignJWT } from 'jose';

export interface InstallationTokenProviderOptions {
  /** GitHub App id. */
  appId: string;
  /** PKCS#8 PEM private key belonging to the App. */
  privateKey: string;
  /** Installation the token is minted for. */
  installationId: string;
  /** GitHub REST base URL. Defaults to `https://api.github.com`. */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for JWT claims and expiry checks; defaults to now. */
  now?: () => Date;
}

/** An Installation Token Provider mints short-lived GitHub tokens. */
export interface InstallationTokenProvider {
  /** A token valid for roughly an hour, cached until it nears expiry. */
  token(): Promise<string>;
}

/**
 * Mints installation tokens from a GitHub App's credentials.
 *
 * Each token is a short-lived (about one hour) bearer token whose access is
 * limited to the permissions the installation was granted, so nothing
 * long-lived with broad repository access is ever handed out or stored.
 */
export function createInstallationTokenProvider(
  options: InstallationTokenProviderOptions,
): InstallationTokenProvider {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | undefined;

  /** Signs the App JWT GitHub requires to act as the App itself. */
  async function appToken(): Promise<string> {
    const key = await importPKCS8(options.privateKey, 'RS256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.appId)
      .setIssuedAt(Math.floor(now().getTime() / 1000) - 60)
      .setExpirationTime(Math.floor(now().getTime() / 1000) + 600)
      .sign(key);
  }

  return {
    async token() {
      // Refresh five minutes before expiry so a call never races the token's
      // death.
      if (cached !== undefined && now().getTime() < cached.expiresAt - 5 * 60 * 1000) {
        return cached.token;
      }
      const jwt = await appToken();
      const response = await doFetch(
        `${apiBaseUrl}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub refused to mint an installation token (${response.status})`);
      }
      const body = (await response.json()) as { token?: string; expires_at?: string };
      if (body.token === undefined || body.expires_at === undefined) {
        throw new Error('GitHub installation token response was missing token or expiry');
      }
      cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
      return cached.token;
    },
  };
}