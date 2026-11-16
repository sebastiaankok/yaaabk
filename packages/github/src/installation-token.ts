import { importPKCS8, SignJWT } from 'jose';
import { toPkcs8Pem } from './private-key';

export interface InstallationTokenProviderOptions {
  /** GitHub App id. */
  appId: string;
  /** PEM private key belonging to the App, in PKCS#1 or PKCS#8 form. */
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

/** A GitHub permission a scoped installation token may request. */
export type InstallationTokenPermission = 'read' | 'write' | 'admin';

/**
 * The permissions a token is narrowed to, keyed by GitHub permission name
 * (`contents`, `pull_requests`, `issues`, …).
 */
export type InstallationTokenPermissions = Record<string, InstallationTokenPermission>;

/** An Installation Token Provider mints short-lived GitHub tokens. */
export interface InstallationTokenProvider {
  /**
   * A token valid for roughly an hour, cached per scope until it nears expiry.
   *
   * When `permissions` is given the token is narrowed to those permissions, so
   * a review Job cannot push and a deploy Job cannot review. Omitting it keeps
   * the installation's full grant.
   */
  token(permissions?: InstallationTokenPermissions): Promise<string>;
}

/** A stable identity for a scope: same permissions in any order. */
function permissionKey(permissions: InstallationTokenPermissions | undefined): string {
  if (permissions === undefined) return '';
  return Object.keys(permissions)
    .sort()
    .map((name) => `${name}:${permissions[name]}`)
    .join(',');
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
  const cached = new Map<string, { token: string; expiresAt: number }>();

  /** Signs the App JWT GitHub requires to act as the App itself. */
  async function appToken(): Promise<string> {
    const key = await importPKCS8(toPkcs8Pem(options.privateKey), 'RS256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.appId)
      .setIssuedAt(Math.floor(now().getTime() / 1000) - 60)
      .setExpirationTime(Math.floor(now().getTime() / 1000) + 600)
      .sign(key);
  }

  return {
    async token(permissions) {
      const cacheKey = permissionKey(permissions);
      const existing = cached.get(cacheKey);
      // Refresh five minutes before expiry so a call never races the token's
      // death.
      if (existing !== undefined && now().getTime() < existing.expiresAt - 5 * 60 * 1000) {
        return existing.token;
      }
      const jwt = await appToken();
      const payload: { permissions?: InstallationTokenPermissions } =
        permissions === undefined ? {} : { permissions };
      const response = await doFetch(
        `${apiBaseUrl}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub refused to mint an installation token (${response.status})`);
      }
      const body = (await response.json()) as { token?: string; expires_at?: string };
      if (body.token === undefined || body.expires_at === undefined) {
        throw new Error('GitHub installation token response was missing token or expiry');
      }
      cached.set(cacheKey, { token: body.token, expiresAt: Date.parse(body.expires_at) });
      return body.token;
    },
  };
}
