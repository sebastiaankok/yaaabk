import { createOpenRouterApi, mintKey, revokeKey, type OpenRouterApi } from '@yaaabk/cost-control';
import type { SessionKeyIssuer } from '@yaaabk/grill-me';

/** How long a session's key may live; the session itself is capped at 4 hours. */
export const SESSION_KEY_TTL_MS = 4 * 60 * 60 * 1000;

/** What the key issuer needs from the running backend. */
export interface SessionKeyIssuerOptions {
  /** Resolves the credential store per call, so Settings changes take effect. */
  credentials: () => Promise<{
    openrouterManagementKey?: string;
    defaultIssueBudgetCents?: number;
  }>;
  /** Environment fallback when Settings holds no management key. */
  envManagementKey?: string;
  /** Spending cap in cents when Settings holds no budget preference. */
  budgetCents: number;
  /** Key lifetime. Defaults to {@link SESSION_KEY_TTL_MS}. */
  ttlMs?: number;
  /** Builds the OpenRouter client for a management key. Defaults to HTTP. */
  api?: (managementKey: string) => OpenRouterApi;
  /** Injected clock. */
  now?: () => Date;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

/** A key minted for one caller, returned once with its plaintext value. */
export interface IssuedOpenRouterKey {
  key: string;
  hash: string;
  expiresAt: string;
}

/** Either a freshly minted key or an actionable reason it could not be made. */
export type OpenRouterKeyResult =
  { ok: true; value: IssuedOpenRouterKey } | { ok: false; message: string };

/** Mints and revokes budgeted OpenRouter keys from the platform credential. */
export interface OpenRouterKeyIssuer {
  /** Mints a key for a stable subject, optionally overriding the default budget. */
  mint(subject: string, budgetCents?: number): Promise<OpenRouterKeyResult>;
  /** Deletes a key by hash. */
  revoke(hash: string): Promise<void>;
}

/** What the per-issue Agent key issuer exposes. */
export interface AgentKeyIssuer {
  /**
   * Mints a key capped at the Issue's budget for one attempt. Each attempt gets
   * its own short-lived key, so a leak cannot outlive the run that created it.
   */
  mint(issueId: string, budgetCents: number, attempt: number): Promise<OpenRouterKeyResult>;
}

const MISSING_CREDENTIAL_MESSAGE =
  'OpenRouter is not configured: add a management key in Settings, or set OPENROUTER_MANAGEMENT_KEY, to run an agent or start a session.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the shared mint/revoke pair.
 *
 * The backend never reuses one key across runs and never exposes the plaintext
 * outside the runtime spec or the per-run Secret.
 */
export function createOpenRouterKeyIssuer(options: SessionKeyIssuerOptions): OpenRouterKeyIssuer {
  const ttlMs = options.ttlMs ?? SESSION_KEY_TTL_MS;
  const buildApi =
    options.api ?? ((managementKey: string) => createOpenRouterApi({ managementKey }));
  const logger = options.logger ?? { info: () => {}, error: () => {} };

  async function resolveCredentials(): Promise<{
    managementKey: string | undefined;
    budgetCents: number;
  }> {
    const stored = await options.credentials();
    const configured = stored.openrouterManagementKey?.trim();
    const fallback = options.envManagementKey?.trim();
    return {
      managementKey:
        configured !== undefined && configured !== ''
          ? configured
          : fallback === undefined || fallback === ''
            ? undefined
            : fallback,
      budgetCents: stored.defaultIssueBudgetCents ?? options.budgetCents,
    };
  }

  return {
    async mint(subject, budgetOverride) {
      const { managementKey, budgetCents } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('openrouter key mint failed: no management credential', { subject });
        return { ok: false, message: MISSING_CREDENTIAL_MESSAGE };
      }
      try {
        const minted = await mintKey(buildApi(managementKey), {
          subject,
          budgetCents: budgetOverride ?? budgetCents,
          ttlMs,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return {
          ok: true,
          value: { key: minted.key, hash: minted.keyHash, expiresAt: minted.expiresAt },
        };
      } catch (error) {
        logger.error('openrouter key mint failed', { subject, message: messageOf(error) });
        return {
          ok: false,
          message: `Could not create the OpenRouter key: ${messageOf(error)}`,
        };
      }
    },

    async revoke(hash) {
      const { managementKey } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('openrouter key revoke skipped: no management credential', { keyHash: hash });
        return;
      }
      try {
        await revokeKey(buildApi(managementKey), hash);
      } catch (error) {
        logger.error('openrouter key revoke failed', { keyHash: hash, message: messageOf(error) });
        throw error;
      }
    },
  };
}

/**
 * Mints and revokes the per-session OpenRouter key from the platform's
 * management credential.
 */
export function createOpenRouterSessionKeys(options: SessionKeyIssuerOptions): SessionKeyIssuer {
  const issuer = createOpenRouterKeyIssuer(options);
  return {
    issue: (sessionId) => issuer.mint(`session-${sessionId}`),
    revoke: (hash) => issuer.revoke(hash),
  };
}

/**
 * Mints the OpenRouter key each Agent attempt runs with, capped at the Issue's
 * budget. The Agent Manager calls this for manual spawns, retries and
 * CI-tracker fix attempts alike, so no run starts without a credential.
 */
export function createOpenRouterAgentKeys(options: SessionKeyIssuerOptions): AgentKeyIssuer {
  const issuer = createOpenRouterKeyIssuer(options);
  return {
    mint: (issueId, budgetCents, attempt) =>
      issuer.mint(`agent-${issueId}-attempt-${attempt}`, budgetCents),
  };
}
