import { describe, expect, it } from 'vitest';
import type {
  InstallationTokenPermissions,
  InstallationTokenProviderOptions,
} from '@yaaabk/github';
import {
  createGitHubTokenResolver,
  GITHUB_CREDENTIALS_UNSET_MESSAGE,
  type GitHubCredentials,
} from './github-token';

type MintOptions = InstallationTokenProviderOptions & {
  permissions?: InstallationTokenPermissions;
};

/** An App whose minting never happens; tests assert on the calls. */
function resolver(mint: (options: MintOptions) => Promise<string>, env: NodeJS.ProcessEnv = {}) {
  const minted: MintOptions[] = [];
  const resolve = createGitHubTokenResolver({
    env,
    mintInstallationToken: (options) => {
      minted.push({
        appId: options.appId,
        privateKey: options.privateKey,
        installationId: options.installationId,
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      });
      return mint(options);
    },
  });
  return { resolve, minted };
}

const APP = {
  githubAppId: '12345',
  githubPrivateKey: 'key',
  githubInstallationId: '67890',
} as const;

describe('createGitHubTokenResolver', () => {
  it('mints an installation token for a fully configured App', async () => {
    const { resolve, minted } = resolver(async () => 'ghs_installation_token');

    const resolved = await resolve(APP);

    expect(resolved).toEqual({ ok: true, token: 'ghs_installation_token' });
    expect(minted).toEqual([{ appId: '12345', privateKey: 'key', installationId: '67890' }]);
  });

  it('forwards the requested permissions when minting a scoped token', async () => {
    const { resolve, minted } = resolver(async () => 'ghs_review');

    const resolved = await resolve(APP, {
      permissions: { contents: 'read', pull_requests: 'write' },
    });

    expect(resolved).toEqual({ ok: true, token: 'ghs_review' });
    expect(minted).toEqual([
      {
        appId: '12345',
        privateKey: 'key',
        installationId: '67890',
        permissions: { contents: 'read', pull_requests: 'write' },
      },
    ]);
  });

  it('blames the missing Installation ID, not a missing PAT', async () => {
    const { resolve, minted } = resolver(async () => 'never');

    const resolved = await resolve({ ...APP, githubInstallationId: undefined });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.gap).toBe('app-without-installation');
    expect(resolved.message).toContain('GitHub App 12345');
    expect(resolved.message).toContain('Installation ID');
    // The point of the message: it names the App, not a PAT.
    expect(resolved.message).not.toContain('personal access token');
    expect(minted).toEqual([]);
  });

  it('reports why minting failed rather than a generic misconfiguration', async () => {
    const { resolve } = resolver(async () => {
      throw new Error('GitHub refused to mint an installation token (401)');
    });

    const resolved = await resolve(APP);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.gap).toBe('app-incomplete');
    expect(resolved.message).toContain('401');
  });

  it('treats a half-filled App as incomplete when no fallback works', async () => {
    const { resolve } = resolver(async () => 'never');

    const resolved = await resolve({ githubAppId: '12345' });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.gap).toBe('app-without-installation');
  });

  it('does not let a half-configured App mask a working PAT', async () => {
    const { resolve } = resolver(async () => 'never');

    const resolved = await resolve({ githubAppId: '12345', githubPat: 'ghp_token' });

    expect(resolved).toEqual({ ok: true, token: 'ghp_token' });
  });

  it('reports the App failure when the App is configured but no PAT works', async () => {
    const { resolve } = resolver(async () => {
      throw new Error('GitHub refused to mint an installation token (401)');
    });

    const resolved = await resolve({ ...APP, githubPat: '' });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.gap).toBe('app-incomplete');
    expect(resolved.message).toContain('401');
  });

  it('falls back to the stored PAT when no App is configured', async () => {
    const { resolve } = resolver(async () => 'never');

    const resolved = await resolve({ githubPat: 'ghp_token' as string } as GitHubCredentials);

    expect(resolved).toEqual({ ok: true, token: 'ghp_token' });
  });

  it('falls back to YAAABK_GITHUB_TOKEN', async () => {
    const { resolve } = resolver(async () => 'never', { YAAABK_GITHUB_TOKEN: 'gho_env' });

    const resolved = await resolve({});

    expect(resolved).toEqual({ ok: true, token: 'gho_env' });
  });

  it('names Settings when nothing at all is configured', async () => {
    const { resolve } = resolver(async () => 'never');

    const resolved = await resolve({});

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.gap).toBe('credentials');
    expect(resolved.message).toBe(GITHUB_CREDENTIALS_UNSET_MESSAGE);
  });
});
