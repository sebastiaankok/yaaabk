import type {
  GitHubAccount,
  GitHubVerifier,
  OpenRouterAccount,
  OpenRouterVerifier,
  VerifyOutcome,
} from './settings';

/**
 * An {@link OpenRouterVerifier} fake for tests. Returns the configured result
 * and records each key it was asked to verify.
 */
export function createFakeOpenRouterVerifier(
  result: VerifyOutcome<OpenRouterAccount> = { ok: true, value: { keys: 3 } },
): OpenRouterVerifier & { verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    async verify(managementKey) {
      verified.push(managementKey);
      return result;
    },
  };
}

/**
 * A {@link GitHubVerifier} fake for tests. Returns the configured result and
 * records how it was asked to verify.
 */
export function createFakeGitHubVerifier(
  result: VerifyOutcome<GitHubAccount> = { ok: true, value: { kind: 'pat', account: 'octocat' } },
): GitHubVerifier & {
  patCalls: string[];
  appCalls: Array<{ appId: string; installationId?: string }>;
} {
  const patCalls: string[] = [];
  const appCalls: Array<{ appId: string; installationId?: string }> = [];
  return {
    patCalls,
    appCalls,
    async verifyWithPat(pat) {
      patCalls.push(pat);
      return result;
    },
    async verifyWithApp(app) {
      appCalls.push({
        appId: app.appId,
        ...(app.installationId === undefined ? {} : { installationId: app.installationId }),
      });
      return result;
    },
  };
}
