import type { AgentOpenrouterKeyResult } from '@yaaabk/agents';
import type { CostControlModule } from '@yaaabk/cost-control';
import type { Issue } from '@yaaabk/issues';
import type { AgentKeyIssuer } from './session-keys';

export interface AgentOpenrouterKeyMinterOptions {
  /** Tracks each Issue's cumulative spend and the key the last attempt used. */
  budgets: CostControlModule;
  /** Mints the per-attempt key, including the reply-reservation preflight. */
  keys: AgentKeyIssuer;
}

/**
 * Builds the Agent Manager's `mintOpenrouterKey`.
 *
 * Every implement, review and fix attempt goes through here. The Issue budget
 * is read cumulatively: the first attempt gets the whole cap, and a later one
 * only the remainder after the previous key's usage. The key itself is still
 * minted per attempt, so one credential never outlives its run.
 */
export function createAgentOpenrouterKeyMinter(
  options: AgentOpenrouterKeyMinterOptions,
): (issue: Issue, attemptNumber: number, model: string) => Promise<AgentOpenrouterKeyResult> {
  return async (issue, attemptNumber, model) => {
    const budget = await options.budgets.beginAttempt(issue.id, {
      budgetCents: issue.budgetCents,
      attempt: attemptNumber,
      priorKeyHash: issue.openrouterKeyHash,
    });
    if (!budget.ok) {
      return { ok: false, message: budget.error.message };
    }

    // The issuer refuses a key whose remainder cannot cover one reply from the
    // selected model, so an exhausted budget never reaches OpenRouter.
    const minted = await options.keys.mint(
      issue.id,
      budget.value.remainingCents,
      attemptNumber,
      model,
    );
    if (!minted.ok) {
      return { ok: false, message: minted.message };
    }

    const recorded = await options.budgets.recordAttempt(issue.id, {
      budgetCents: issue.budgetCents,
      attempt: attemptNumber,
      keyHash: minted.value.hash,
      spentCents: budget.value.spentCents,
      expiresAt: minted.value.expiresAt,
      createdAt: minted.value.createdAt,
    });
    if (!recorded.ok) {
      return {
        ok: false,
        message: `The OpenRouter key was created but its Issue budget could not be recorded, so the attempt was not started: ${recorded.error.message}`,
      };
    }

    return { ok: true, key: minted.value.key, hash: minted.value.hash };
  };
}
