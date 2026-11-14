import { MAX_ISSUE_BUDGET_CENTS } from '@yaaabk/cost-control';
import type { SecretCrypto } from './secret-crypto';
import { maskSecret } from './secret-crypto';
import type { CredentialField, CredentialValue, SettingsRecord, SettingsStore } from './types';

/** The lowest per-Issue budget a Developer may configure, in whole cents. */
export const MIN_ISSUE_BUDGET_CENTS = 1;

/** The kinds of failure a Settings command can report. */
export type SettingsErrorKind = 'invalid-input' | 'unauthorized';

/** A typed failure, never thrown across the module boundary. */
export interface SettingsError {
  kind: SettingsErrorKind;
  operation: 'update' | 'verify-openrouter' | 'verify-github';
  message: string;
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: SettingsError };

/** A credential or preference as the Developer sees it: masked, never plaintext. */
export interface SettingsView {
  githubAppId?: string;
  githubPrivateKey?: string;
  githubInstallationId?: string;
  githubPat?: string;
  openrouterManagementKey?: string;
  defaultIssueBudgetCents?: number;
  updatedAt: string;
}

/** Fields the Developer may change; `undefined` leaves a field untouched. */
export interface SettingsUpdate {
  githubAppId?: string;
  githubPrivateKey?: string;
  githubInstallationId?: string;
  githubPat?: string;
  openrouterManagementKey?: string;
  defaultIssueBudgetCents?: number;
  /** Credential fields to remove entirely. */
  clear?: CredentialField[];
}

export interface SettingsModule {
  /** The settings as safe to show in the browser: masked hints only. */
  get(): Promise<SettingsView>;
  /** Persists the given fields, encrypting credential values at rest. */
  update(update: SettingsUpdate): Promise<SettingsResult<SettingsView>>;
  /**
   * The stored credentials decrypted for use inside the backend — building
   * GitHub/OpenRouter clients. Never exposed through the API.
   */
  credentials(): Promise<DecryptedSettings>;
  /** Checks the stored OpenRouter management key with OpenRouter. */
  verifyOpenRouter(): Promise<SettingsResult<OpenRouterAccount>>;
  /** Checks the stored GitHub credentials (App preferred, PAT otherwise). */
  verifyGitHub(): Promise<SettingsResult<GitHubAccount>>;
}

/** Plaintext credentials for backend use only; mirrors {@link SettingsRecord}. */
export interface DecryptedSettings {
  githubAppId?: string;
  githubPrivateKey?: string;
  githubInstallationId?: string;
  githubPat?: string;
  openrouterManagementKey?: string;
  defaultIssueBudgetCents?: number;
}

/** What OpenRouter reports about a management key. */
export interface OpenRouterAccount {
  account: string;
}

/** Verifies a management key with OpenRouter's Management API. */
export interface OpenRouterVerifier {
  verify(managementKey: string): Promise<SettingsResult<OpenRouterAccount>>;
}

/** How the configured GitHub credentials authenticate. */
export type GitHubCredentialKind = 'pat' | 'app';

/** What GitHub reports about the resolved credentials. */
export interface GitHubAccount {
  kind: GitHubCredentialKind;
  /** The login the credentials resolve to (user for a PAT, app or org otherwise). */
  account: string;
}

/** Verifies GitHub credentials, either a PAT or a GitHub App installation. */
export interface GitHubVerifier {
  verifyWithPat(pat: string): Promise<SettingsResult<GitHubAccount>>;
  verifyWithApp(app: {
    appId: string;
    privateKey: string;
    installationId?: string;
  }): Promise<SettingsResult<GitHubAccount>>;
}

const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  'githubAppId',
  'githubPrivateKey',
  'githubInstallationId',
  'githubPat',
  'openrouterManagementKey',
];

export function createSettingsModule({
  store,
  crypto,
  openRouterVerifier,
  githubVerifier,
}: {
  store: SettingsStore;
  crypto: SecretCrypto;
  openRouterVerifier: OpenRouterVerifier;
  githubVerifier: GitHubVerifier;
}): SettingsModule {
  function viewOf(record: SettingsRecord): SettingsView {
    const masked: SettingsView = { updatedAt: record.updatedAt };
    for (const field of CREDENTIAL_FIELDS) {
      const credential: CredentialValue | undefined = record[field];
      if (credential !== undefined) {
        masked[field] = credential.hint;
      }
    }
    if (record.defaultIssueBudgetCents !== undefined) {
      masked.defaultIssueBudgetCents = record.defaultIssueBudgetCents;
    }
    return masked;
  }

  async function credentials(): Promise<DecryptedSettings> {
    const record = store.load();
    const decrypted: DecryptedSettings = {};
    if (record === undefined) {
      return decrypted;
    }
    for (const field of CREDENTIAL_FIELDS) {
      const credential: CredentialValue | undefined = record[field];
      if (credential !== undefined) {
        decrypted[field] = crypto.decrypt(credential.ciphertext);
      }
    }
    if (record.defaultIssueBudgetCents !== undefined) {
      decrypted.defaultIssueBudgetCents = record.defaultIssueBudgetCents;
    }
    return decrypted;
  }

  return {
    get: () => {
      const record = store.load();
      return Promise.resolve(record === undefined ? { updatedAt: new Date(0).toISOString() } : viewOf(record));
    },
    async update(update) {
      const budget = update.defaultIssueBudgetCents;
      if (
        budget !== undefined &&
        (!Number.isInteger(budget) || budget < MIN_ISSUE_BUDGET_CENTS || budget > MAX_ISSUE_BUDGET_CENTS)
      ) {
        return {
          ok: false,
          error: {
            kind: 'invalid-input',
            operation: 'update',
            message: `defaultIssueBudgetCents must be a whole number between ${MIN_ISSUE_BUDGET_CENTS} and ${MAX_ISSUE_BUDGET_CENTS}`,
          },
        };
      }

      const stored = store.load();
      const next: SettingsRecord = {
        updatedAt: new Date().toISOString(),
        ...(stored ?? {}),
      };
      for (const field of CREDENTIAL_FIELDS) {
        const value = update[field];
        if (value !== undefined) {
          next[field] = {
            ciphertext: crypto.encrypt(value),
            hint: maskSecret(value),
          };
        } else if (update.clear?.includes(field)) {
          delete next[field];
        }
      }
      if (budget !== undefined) {
        next.defaultIssueBudgetCents = budget;
      }
      store.save(next);
      return { ok: true, value: viewOf(next) };
    },
    credentials,
    async verifyOpenRouter() {
      const { openrouterManagementKey } = await credentials();
      if (openrouterManagementKey === undefined) {
        return {
          ok: false,
          error: {
            kind: 'unauthorized',
            operation: 'verify-openrouter',
            message: 'No OpenRouter management key is configured',
          },
        };
      }
      return openRouterVerifier.verify(openrouterManagementKey);
    },
    async verifyGitHub() {
      const { githubAppId, githubPrivateKey, githubInstallationId, githubPat } = await credentials();
      if (githubAppId !== undefined && githubPrivateKey !== undefined) {
        return githubVerifier.verifyWithApp({
          appId: githubAppId,
          privateKey: githubPrivateKey,
          ...(githubInstallationId === undefined ? {} : { installationId: githubInstallationId }),
        });
      }
      if (githubPat !== undefined) {
        return githubVerifier.verifyWithPat(githubPat);
      }
      return {
        ok: false,
        error: {
          kind: 'unauthorized',
          operation: 'verify-github',
          message: 'No GitHub credentials are configured',
        },
      };
    },
  };
}
