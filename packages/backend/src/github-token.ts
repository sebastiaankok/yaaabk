import type {
  InstallationTokenPermissions,
  InstallationTokenProviderOptions,
} from '@yaaabk/github';
import type { DecryptedSettings } from '@yaaabk/settings';

/** Why no GitHub token could be resolved, so callers can name the real gap. */
export type GitHubTokenGap = 'app-without-installation' | 'app-incomplete' | 'credentials';

/** A GitHub token, or the reason there is none and how to fix it. */
export type ResolvedGitHubToken =
  { ok: true; token: string } | { ok: false; gap: GitHubTokenGap; message: string };

/** The credentials this module resolves a token from. */
export type GitHubCredentials = Pick<
  DecryptedSettings,
  'githubAppId' | 'githubPrivateKey' | 'githubInstallationId' | 'githubPat'
>;

export interface GitHubTokenResolverOptions {
  /**
   * Mints an installation token for the given App. Injected so the resolution
   * rules are unit-testable without a private key or a network call.
   *
   * `permissions` narrows the token to what the caller needs; omitting it keeps
   * the installation's full grant.
   */
  mintInstallationToken(
    options: InstallationTokenProviderOptions & {
      permissions?: InstallationTokenPermissions;
    },
  ): Promise<string>;
  /** Environment fallback for the token; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** The token resolution options a caller may add. */
export interface GitHubTokenRequest {
  permissions?: InstallationTokenPermissions;
}

/** The resolver: credentials in, token or reason out. */
export type GitHubTokenResolver = (
  credentials: GitHubCredentials,
  request?: GitHubTokenRequest,
) => Promise<ResolvedGitHubToken>;

/** Where an App with no Installation ID is installed from. */
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/yaaabk/installations/new';

export const GITHUB_CREDENTIALS_UNSET_MESSAGE =
  'No GitHub credentials are configured. Add a GitHub App (App ID, private key and Installation ID) or a personal access token in Settings.';

export const GITHUB_OWNER_UNSET_MESSAGE =
  'No GitHub owner is configured. Set YAAABK_GITHUB_OWNER to the account new Project repositories are created under — for a GitHub App, the account the App is installed on.';

/**
 * Builds the token resolver the backend's GitHub ports share.
 *
 * The result says *why* there is no token, rather than one generic "GitHub is
 * not configured": an App that was never installed needs a different fix from
 * having no credential at all, and telling someone with an App to add a PAT
 * sends them on a detour.
 *
 * A configured GitHub App wins: its installation token is short-lived (roughly
 * an hour) and scoped to the permissions the installation was granted, so
 * nothing long-lived with broad repository access is ever used. The stored PAT
 * and the environment variable remain fallbacks.
 */
export function createGitHubTokenResolver({
  mintInstallationToken,
  env = process.env,
}: GitHubTokenResolverOptions): GitHubTokenResolver {
  return async (credentials, request = {}) => {
    const appId = credentials.githubAppId ?? '';
    const privateKey = credentials.githubPrivateKey ?? '';
    const installationId = credentials.githubInstallationId ?? '';
    const appConfigured = appId !== '' || privateKey !== '' || installationId !== '';

    // The App is tried first, but a failure is not fatal on its own: a stored
    // PAT or the environment variable may still work, and someone with both
    // should not be blocked by a half-configured App. The reason is kept and
    // reported only when no fallback succeeds.
    let appFailure: Extract<ResolvedGitHubToken, { ok: false }> | undefined;
    if (appId !== '' && privateKey !== '' && installationId !== '') {
      try {
        return {
          ok: true,
          token: await mintInstallationToken({
            appId,
            privateKey,
            installationId,
            ...(request.permissions === undefined ? {} : { permissions: request.permissions }),
          }),
        };
      } catch (cause) {
        appFailure = {
          ok: false,
          gap: 'app-incomplete',
          message: `GitHub App ${appId} could not mint an installation token: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        };
      }
    } else if (appConfigured) {
      appFailure = {
        ok: false,
        gap: 'app-without-installation',
        // An installation token is minted for exactly one installation, so an
        // App without an Installation ID has no token to offer.
        message:
          installationId === ''
            ? `GitHub App ${appId || '(no App ID)'} is configured without an Installation ID. Install it at ${GITHUB_APP_INSTALL_URL} and enter the Installation ID in Settings.`
            : 'GitHub App credentials are incomplete. Add the App ID, private key and Installation ID in Settings.',
      };
    }

    const pat = credentials.githubPat ?? '';
    if (pat !== '') {
      return { ok: true, token: pat };
    }

    const fromEnv = env.YAAABK_GITHUB_TOKEN;
    if (fromEnv !== undefined && fromEnv !== '') {
      return { ok: true, token: fromEnv };
    }

    if (appFailure !== undefined) {
      return appFailure;
    }

    return { ok: false, gap: 'credentials', message: GITHUB_CREDENTIALS_UNSET_MESSAGE };
  };
}
