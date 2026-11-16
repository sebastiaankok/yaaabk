import { createOpenRouterApi, mintKey, revokeKey, type OpenRouterApi } from '@yaaabk/cost-control';
import type { SessionKeyIssuer } from '@yaaabk/grill-me';

/** How long a session's key may live; the session itself is capped at 4 hours. */
export const SESSION_KEY_TTL_MS = 4 * 60 * 60 * 1000;

/** What the session key issuer needs from the running backend. */
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

const MISSING_CREDENTIAL_MESSAGE =
  'OpenRouter is not configured: add a management key in Settings, or set OPENROUTER_MANAGEMENT_KEY, to start a session.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mints and revokes the per-session OpenRouter key from the platform's
 * management credential.
 *
 * The backend never reuses one key across sessions and never exposes the
 * plaintext outside the runtime spec.
 */
export function createOpenRouterSessionKeys(options: SessionKeyIssuerOptions): SessionKeyIssuer {
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
    async issue(sessionId) {
      const { managementKey, budgetCents } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('session key mint failed: no management credential', { sessionId });
        return { ok: false, message: MISSING_CREDENTIAL_MESSAGE };
      }
      try {
        const minted = await mintKey(buildApi(managementKey), {
          subject: `session-${sessionId}`,
          budgetCents,
          ttlMs,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return {
          ok: true,
          value: { key: minted.key, hash: minted.keyHash, expiresAt: minted.expiresAt },
        };
      } catch (error) {
        logger.error('session key mint failed', { sessionId, message: messageOf(error) });
        return {
          ok: false,
          message: `Could not create the session OpenRouter key: ${messageOf(error)}`,
        };
      }
    },

    async revoke(hash) {
      const { managementKey } = await resolveCredentials();
      if (managementKey === undefined) {
        logger.error('session key revoke skipped: no management credential', { keyHash: hash });
        return;
      }
      try {
        await revokeKey(buildApi(managementKey), hash);
      } catch (error) {
        logger.error('session key revoke failed', { keyHash: hash, message: messageOf(error) });
        throw error;
      }
    },
  };
}
