import {
  createFakeOpenRouterApi,
  type FakeOpenRouterApi,
  type ModelCatalogue,
  type SessionModel,
} from '@yaaabk/cost-control';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterAgentKeys, createOpenRouterSessionKeys } from './session-keys';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const SONNET: SessionModel = {
  id: 'openrouter/anthropic/claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  contextLength: 200000,
  maxCompletionTokens: 64000,
  promptUsdPerMillion: 3,
  completionUsdPerMillion: 15,
};

const FREE: SessionModel = {
  id: 'openrouter/baidu/ernie-5.5-flash-preview:free',
  name: 'Ernie',
  contextLength: 1024000,
  maxCompletionTokens: 921600,
  promptUsdPerMillion: 0,
  completionUsdPerMillion: 0,
};

/** A catalogue that only knows the models a test names. */
function catalogueOf(...models: SessionModel[]): ModelCatalogue {
  return { list: async () => ({ ok: true, value: models }) };
}

function setup(
  options: {
    storedManagementKey?: string;
    envManagementKey?: string;
    storedBudgetCents?: number;
    api?: FakeOpenRouterApi;
    catalogue?: ModelCatalogue;
  } = {},
) {
  const api = options.api ?? createFakeOpenRouterApi();
  const keys = createOpenRouterSessionKeys({
    credentials: async () => ({
      ...(options.storedManagementKey === undefined
        ? {}
        : { openrouterManagementKey: options.storedManagementKey }),
      ...(options.storedBudgetCents === undefined
        ? {}
        : { defaultIssueBudgetCents: options.storedBudgetCents }),
    }),
    ...(options.envManagementKey === undefined
      ? {}
      : { envManagementKey: options.envManagementKey }),
    budgetCents: 50,
    ttlMs: 4 * 60 * 60 * 1000,
    ...(options.catalogue === undefined ? {} : { catalogue: options.catalogue }),
    api: () => api,
    now: () => NOW,
    logger: { info: () => {}, error: () => {} },
  });
  return { api, keys };
}

describe('session OpenRouter keys', () => {
  it('mints a budgeted, expiring key for the session from the stored credential', async () => {
    const { api, keys } = setup({ storedManagementKey: 'sk-or-management' });

    const result = await keys.issue('s1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      key: 'sk-or-v1-1',
      hash: 'hash-1',
      expiresAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    });
    expect(api.lastCreate).toEqual({
      name: 'yaaabk-session-s1',
      limitUsd: 0.5,
      limitReset: null,
      expiresAt: result.value.expiresAt,
    });
  });

  it('uses the budget stored in Settings when there is one', async () => {
    const { api, keys } = setup({
      storedManagementKey: 'sk-or-management',
      storedBudgetCents: 200,
    });

    await keys.issue('s1');

    expect(api.lastCreate?.limitUsd).toBe(2);
  });

  it('falls back to the environment management key', async () => {
    const { api, keys } = setup({ envManagementKey: 'sk-or-env' });

    const result = await keys.issue('s1');

    expect(result.ok).toBe(true);
    expect(api.calls).toEqual(['createKey']);
  });

  it('names what to configure when no management key exists', async () => {
    const { api, keys } = setup();

    const result = await keys.issue('s1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Settings');
      expect(result.message).toContain('management key');
    }
    expect(api.calls).toEqual([]);
  });

  it('reports an OpenRouter failure as an actionable start failure', async () => {
    const { api, keys } = setup({ storedManagementKey: 'sk-or-management' });
    api.fail('createKey', new Error('Rate limit exceeded'));

    const result = await keys.issue('s1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Rate limit exceeded');
  });

  it('revokes a key by hash', async () => {
    const { api, keys } = setup({ storedManagementKey: 'sk-or-management' });

    await keys.revoke('hash-1');

    expect(api.calls).toEqual(['deleteKey']);
  });

  it('does not call OpenRouter to revoke when no credential is configured', async () => {
    const { api, keys } = setup();

    await keys.revoke('hash-1');

    expect(api.calls).toEqual([]);
  });
});

describe('agent OpenRouter keys', () => {
  it("caps the key at the Issue's budget and names the attempt", async () => {
    const api = createFakeOpenRouterApi();
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 50,
      ttlMs: 4 * 60 * 60 * 1000,
      api: () => api,
      now: () => NOW,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 200, 2);

    expect(result.ok).toBe(true);
    expect(api.lastCreate).toEqual({
      name: 'yaaabk-agent-issue-1-attempt-2',
      limitUsd: 2,
      limitReset: null,
      expiresAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('reports a missing management credential instead of calling OpenRouter', async () => {
    const api = createFakeOpenRouterApi();
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({}),
      budgetCents: 50,
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 50, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('management key');
    expect(api.calls).toEqual([]);
  });

  it('refuses a budget that cannot cover one full reply before minting a key', async () => {
    const api = createFakeOpenRouterApi();
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 50,
      catalogue: catalogueOf(SONNET),
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 50, 1, SONNET.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('$0.50 budget');
      expect(result.message).toContain('$0.96');
      expect(result.message).toContain('Raise the budget');
    }
    expect(api.calls).toEqual([]);
  });

  it("refuses a paid model when the account's credits cannot cover one reply", async () => {
    const api = createFakeOpenRouterApi();
    api.setCredits(40, 39.9928);
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 500,
      catalogue: catalogueOf(SONNET),
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 500, 1, SONNET.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('less than $0.01 in credits');
      expect(result.message).toContain('$0.96');
      expect(result.message).toContain('https://openrouter.ai/settings/credits');
    }
    expect(api.calls).toEqual(['getCredits']);
  });

  it('mints the key when the budget and account balance both cover the reply', async () => {
    const api = createFakeOpenRouterApi();
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 500,
      catalogue: catalogueOf(SONNET),
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 500, 1, SONNET.id);

    expect(result.ok).toBe(true);
    expect(api.calls).toEqual(['getCredits', 'createKey']);
  });

  it('skips the balance check for a free model', async () => {
    const api = createFakeOpenRouterApi();
    api.setCredits(0, 0);
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 1,
      catalogue: catalogueOf(FREE),
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 1, 1, FREE.id);

    expect(result.ok).toBe(true);
    expect(api.calls).toEqual(['createKey']);
  });

  it('never blocks a run because the balance lookup failed', async () => {
    const api = createFakeOpenRouterApi();
    api.fail('getCredits', new Error('balance endpoint unavailable'));
    const keys = createOpenRouterAgentKeys({
      credentials: async () => ({ openrouterManagementKey: 'sk-or-management' }),
      budgetCents: 500,
      catalogue: catalogueOf(SONNET),
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    const result = await keys.mint('issue-1', 500, 1, SONNET.id);

    expect(result.ok).toBe(true);
    expect(api.calls).toEqual(['getCredits', 'createKey']);
  });
});

describe('session OpenRouter key preflight', () => {
  it('refuses a session model whose reply reservation exceeds the default budget', async () => {
    const { api, keys } = setup({
      storedManagementKey: 'sk-or-management',
      catalogue: catalogueOf(SONNET),
    });

    const result = await keys.issue('s1', SONNET.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('$0.50 budget');
    expect(api.calls).toEqual([]);
  });
});

// Ensure the injected API is not reached before the credential check.
describe('credential resolution', () => {
  it('resolves credentials per call so Settings changes take effect', async () => {
    const credentials = vi.fn(async () => ({ openrouterManagementKey: 'sk-or-management' }));
    const api = createFakeOpenRouterApi();
    const keys = createOpenRouterSessionKeys({
      credentials,
      budgetCents: 50,
      api: () => api,
      logger: { info: () => {}, error: () => {} },
    });

    await keys.issue('s1');
    await keys.issue('s2');

    expect(credentials).toHaveBeenCalledTimes(2);
    expect(api.calls).toEqual(['createKey', 'createKey']);
  });
});
