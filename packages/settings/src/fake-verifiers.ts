import type { OpenRouterCredits } from '@yaaabk/cost-control';
import type {
  GitHubAccount,
  GitHubVerifier,
  OpenRouterAccount,
  OpenRouterCreditsReader,
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
 * An {@link OpenRouterCreditsReader} fake for tests. Starts with a healthy
 * balance and records each management key it was asked to read with.
 */
export function createFakeOpenRouterCreditsReader(
  result: VerifyOutcome<OpenRouterCredits> = {
    ok: true,
    value: { totalCreditsUsd: 10, totalUsageUsd: 1, remainingUsd: 9 },
  },
): OpenRouterCreditsReader & {
  readKeys: string[];
  setCredits(credits: OpenRouterCredits): void;
  fail(outcome: Extract<VerifyOutcome<OpenRouterCredits>, { ok: false }>): void;
} {
  const readKeys: string[] = [];
  let outcome = result;
  return {
    readKeys,
    setCredits(credits) {
      outcome = { ok: true, value: credits };
    },
    fail(failure) {
      outcome = failure;
    },
    async read(managementKey) {
      readKeys.push(managementKey);
      return outcome;
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
