import {
  createCostControlModule,
  createFakeOpenRouterApi,
  createInMemoryBudgetStore,
  OpenRouterApiError,
  silentLogger,
  type ModelCatalogue,
  type SessionModel,
} from '@yaaabk/cost-control';
import type { Issue } from '@yaaabk/issues';
import { describe, expect, it } from 'vitest';
import { createAgentOpenrouterKeyMinter } from './agent-keys';
import { createOpenRouterAgentKeys } from './session-keys';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const SONNET: SessionModel = {
  id: 'openrouter/anthropic/claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  contextLength: 200000,
  maxCompletionTokens: 64000,
  promptUsdPerMillion: 3,
  completionUsdPerMillion: 15,
};

function catalogueOf(...models: SessionModel[]): ModelCatalogue {
  return { list: async () => ({ ok: true, value: models }) };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    projectId: 'project-1',
    planId: null,
    githubNumber: 1,
    githubSyncedAt: null,
    title: 'Add login',
    body: '',
    summary: null,
    status: 'open',
    label: 'ready',
    dependsOn: [],
    attemptCount: 0,
    maxAttempts: 3,
    budgetCents: 50,
    openrouterKeyHash: null,
    agentModel: null,
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(models: SessionModel[] = []) {
  const api = createFakeOpenRouterApi();
  const budgets = createCostControlModule({
    api,
    store: createInMemoryBudgetStore(),
    now: () => NOW,
    logger: silentLogger,
  });
  const keys = createOpenRouterAgentKeys({
    credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
    budgetCents: 100,
    ttlMs: 4 * 60 * 60 * 1000,
    api: () => api,
    now: () => NOW,
    logger: silentLogger,
    ...(models.length === 0 ? {} : { catalogue: catalogueOf(...models) }),
  });
  return { api, budgets, keys, mint: createAgentOpenrouterKeyMinter({ budgets, keys }) };
}

describe('Agent OpenRouter key minter', () => {
  it('draws every attempt from one cumulative Issue cap while keeping each key separate', async () => {
    const { api, mint } = setup();
    const target = issue({ budgetCents: 50 });

    const first = await mint(target, 1, 'openrouter/free');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(api.lastCreate?.limitUsd).toBe(0.5);

    api.setUsage(first.hash, 0.3);
    const second = await mint(
      issue({ budgetCents: 50, openrouterKeyHash: first.hash, attemptCount: 1 }),
      2,
      'openrouter/free',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The second attempt may only spend what the first left behind.
    expect(api.lastCreate?.limitUsd).toBe(0.2);
    // It still gets its own short-lived credential, not the first key back.
    expect(second.key).not.toBe(first.key);
    expect(second.hash).not.toBe(first.hash);
    expect(api.created).toHaveLength(2);

    api.setUsage(second.hash, 0.2);
    const third = await mint(
      issue({ budgetCents: 50, openrouterKeyHash: second.hash, attemptCount: 2 }),
      3,
      'openrouter/free',
    );

    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.reason).toBe('budget-exhausted');
    expect(third.message).toContain('nothing for another attempt');
    expect(api.created).toHaveLength(2);
  });

  it('refuses a later attempt when its remainder cannot cover one reply', async () => {
    const { api, mint } = setup([SONNET]);
    const first = await mint(issue({ budgetCents: 200 }), 1, SONNET.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    api.setUsage(first.hash, 1.2);
    const second = await mint(
      issue({ budgetCents: 200, openrouterKeyHash: first.hash, attemptCount: 1 }),
      2,
      SONNET.id,
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('reply-reservation');
    expect(second.remainingCents).toBe(80);
    expect(second.spentCents).toBe(120);
    // The Developer is told every amount involved and what to change.
    expect(second.message).toContain('$0.80 remains');
    expect(second.message).toContain('$2.00 budget');
    expect(second.message).toContain('$1.20 spent');
    expect(second.message).toContain('$0.96');
    expect(second.message).toContain('Raise the Issue’s budget');
    expect(second.message).toContain('cheaper model');
    expect(api.created).toHaveLength(1);
  });

  it('draws a raised budget for the next attempt without resetting prior spend', async () => {
    const { api, mint } = setup();
    const first = await mint(issue({ budgetCents: 100 }), 1, 'openrouter/free');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    api.setUsage(first.hash, 0.6);

    const second = await mint(
      issue({ budgetCents: 250, openrouterKeyHash: first.hash, attemptCount: 1 }),
      2,
      'openrouter/free',
    );

    expect(second.ok).toBe(true);
    // The raise adds to the remainder; the $0.60 already spent stays spent.
    expect(api.lastCreate?.limitUsd).toBe(1.9);
  });

  it('refuses a later attempt when the prior spend cannot be read', async () => {
    const { api, mint } = setup();
    const first = await mint(issue(), 1, 'openrouter/free');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    api.fail('getKey', new OpenRouterApiError('API key not found', { statusCode: 404 }));
    const second = await mint(
      issue({ openrouterKeyHash: first.hash, attemptCount: 1 }),
      2,
      'openrouter/free',
    );

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain('remaining budget is unknown');
    expect(second.message).toContain('check the OpenRouter management key');
    expect(api.created).toHaveLength(1);
  });
});
