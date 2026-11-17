import { createFakeOpenRouterApi, type FakeOpenRouterApi } from '@yaaabk/cost-control';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterAgentKeys, createOpenRouterSessionKeys } from './session-keys';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function setup(
  options: {
    storedManagementKey?: string;
    envManagementKey?: string;
    storedBudgetCents?: number;
    api?: FakeOpenRouterApi;
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
