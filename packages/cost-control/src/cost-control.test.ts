import { describe, expect, it } from 'vitest';
import { createInMemoryBudgetStore, type BudgetStore } from './budget-store';
import { DEFAULT_ISSUE_BUDGET_CENTS, KEY_TTL_MS, MAX_ISSUE_BUDGET_CENTS } from './config';
import { createCostControlModule, type CostControlModuleOptions } from './cost-control';
import { OpenRouterApiError, silentLogger } from './errors';
import { createFakeOpenRouterApi, type FakeOpenRouterApi } from './fake-openrouter-api';
import type { CostControlModule } from './types';

/** A fixed clock so expiry assertions are exact rather than approximate. */
const NOW = new Date('2026-11-13T09:00:00.000Z');
const THIRTY_DAYS_LATER = new Date(NOW.getTime() + KEY_TTL_MS).toISOString();

interface Harness {
  api: FakeOpenRouterApi;
  store: BudgetStore;
  module: CostControlModule;
}

function setup(overrides: Partial<CostControlModuleOptions> = {}): Harness {
  const api = createFakeOpenRouterApi();
  const store = overrides.store ?? createInMemoryBudgetStore();
  const module = createCostControlModule({
    api,
    store,
    now: () => NOW,
    logger: silentLogger,
    ...overrides,
  });
  return { api, store, module };
}

describe('Cost Control Module', () => {
  describe('open', () => {
    it('creates a per-issue key with the default budget, a lifetime cap and a 30-day expiry', async () => {
      const { api, module } = setup();

      const result = await module.open('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.budgetCents).toBe(DEFAULT_ISSUE_BUDGET_CENTS);
      expect(result.value.expiresAt).toBe(THIRTY_DAYS_LATER);
      expect(result.value.createdAt).toBe(NOW.toISOString());
      // The plaintext key comes straight from OpenRouter and is returned once.
      expect(result.value.key).toBe(api.created[0]?.key);
      expect(result.value.keyHash).toBe(api.created[0]?.keyInfo.hash);
      expect(api.lastCreate).toEqual({
        name: 'yaaabk-issue-issue-1',
        limitUsd: 0.5,
        limitReset: null,
        expiresAt: THIRTY_DAYS_LATER,
      });
    });

    it('honours a per-issue budget override', async () => {
      const { api, module } = setup();

      const result = await module.open('issue-1', { budgetCents: 200 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.budgetCents).toBe(200);
      expect(api.lastCreate?.limitUsd).toBe(2);
    });

    it('refuses a second key for an issue that already has one', async () => {
      const { api, module } = setup();
      await module.open('issue-1');

      const result = await module.open('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('already-open');
      expect(api.calls).toEqual(['createKey']);
    });

    it('rejects a budget above the system ceiling without calling OpenRouter', async () => {
      const { api, module } = setup();

      const result = await module.open('issue-1', { budgetCents: MAX_ISSUE_BUDGET_CENTS + 1 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('budget-out-of-range');
      expect(api.calls).toEqual([]);
    });

    it('rejects a budget that is not a positive whole number of cents', async () => {
      const { api, module } = setup();

      const zero = await module.open('issue-1', { budgetCents: 0 });
      const fractional = await module.open('issue-2', { budgetCents: 12.5 });

      expect(zero.ok).toBe(false);
      expect(fractional.ok).toBe(false);
      if (zero.ok || fractional.ok) return;
      expect(zero.error.kind).toBe('invalid-input');
      expect(fractional.error.kind).toBe('invalid-input');
      expect(api.calls).toEqual([]);
    });
  });

  describe('topUp', () => {
    it('raises the spending cap at OpenRouter and records the new budget', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');

      const result = await module.topUp('issue-1', 300);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.budgetCents).toBe(300);
      expect(api.lastUpdate).toEqual({ hash: opened.value.keyHash, input: { limitUsd: 3 } });
    });

    it('rejects a budget above the system ceiling without calling OpenRouter', async () => {
      const { api, module } = setup();
      await module.open('issue-1');

      const result = await module.topUp('issue-1', MAX_ISSUE_BUDGET_CENTS + 1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('budget-out-of-range');
      expect(api.calls).toEqual(['createKey']);
    });

    it('reports not-open for an issue without a key', async () => {
      const { api, module } = setup();

      const result = await module.topUp('issue-1', 300);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('not-open');
      expect(api.calls).toEqual([]);
    });
  });

  describe('status', () => {
    it('reports the remaining budget in cents from OpenRouter usage', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');
      api.setUsage(opened.value.keyHash, 0.2);

      const result = await module.status('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        issueId: 'issue-1',
        keyHash: opened.value.keyHash,
        budgetCents: 50,
        usedCents: 20,
        remainingCents: 30,
        expiresAt: THIRTY_DAYS_LATER,
        disabled: false,
        exhausted: false,
      });
      expect(JSON.stringify(result.value)).not.toContain('sk-or-');
    });

    it('marks the budget exhausted once it is spent', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');
      api.setUsage(opened.value.keyHash, 0.5);

      const result = await module.status('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.remainingCents).toBe(0);
      expect(result.value.exhausted).toBe(true);
    });

    it('marks the budget exhausted when the key is disabled', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');
      api.setDisabled(opened.value.keyHash, true);

      const result = await module.status('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.disabled).toBe(true);
      expect(result.value.exhausted).toBe(true);
    });

    it('marks the budget exhausted once the key expires', async () => {
      let current = NOW;
      const { module } = setup({ now: () => current });
      await module.open('issue-1');
      current = new Date(NOW.getTime() + KEY_TTL_MS + 1000);

      const result = await module.status('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.exhausted).toBe(true);
    });

    it('reports not-open for an issue without a key', async () => {
      const { api, module } = setup();

      const result = await module.status('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('not-open');
      expect(api.calls).toEqual([]);
    });
  });

  describe('release', () => {
    it('deletes the key at OpenRouter and forgets the budget', async () => {
      const { api, module } = setup();
      await module.open('issue-1');

      const result = await module.release('issue-1');

      expect(result.ok).toBe(true);
      expect(api.calls).toEqual(['createKey', 'deleteKey']);
      const status = await module.status('issue-1');
      expect(status.ok).toBe(false);
      if (status.ok) return;
      expect(status.error.kind).toBe('not-open');
    });

    it('is a no-op for an issue that was never open', async () => {
      const { api, module } = setup();

      const result = await module.release('issue-1');

      expect(result.ok).toBe(true);
      expect(api.calls).toEqual([]);
    });

    it('is idempotent', async () => {
      const { api, module } = setup();
      await module.open('issue-1');

      await module.release('issue-1');
      const second = await module.release('issue-1');

      expect(second.ok).toBe(true);
      expect(api.calls).toEqual(['createKey', 'deleteKey']);
    });

    it('clears the budget when OpenRouter reports the key already deleted', async () => {
      const { api, module } = setup();
      await module.open('issue-1');
      api.fail('deleteKey', new OpenRouterApiError('API key not found', { statusCode: 404 }));

      const result = await module.release('issue-1');

      expect(result.ok).toBe(true);
      const status = await module.status('issue-1');
      expect(status.ok).toBe(false);
    });

    it('keeps the budget when OpenRouter fails for any other reason', async () => {
      const { api, module } = setup();
      await module.open('issue-1');
      api.fail('deleteKey', new OpenRouterApiError('boom', { statusCode: 500 }));

      const result = await module.release('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('server');
      const status = await module.status('issue-1');
      expect(status.ok).toBe(true);
    });
  });

  describe('error mapping', () => {
    it('maps an unauthorised management key to unauthorized', async () => {
      const { api, module } = setup();
      api.fail(
        'createKey',
        new OpenRouterApiError('Only management keys can perform this operation', {
          statusCode: 403,
        }),
      );

      const result = await module.open('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unauthorized');
      expect(result.error.statusCode).toBe(403);
    });

    it('maps rate limiting to rate-limited', async () => {
      const { api, module } = setup();
      api.fail('createKey', new OpenRouterApiError('Rate limit exceeded', { statusCode: 429 }));

      const result = await module.open('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('rate-limited');
    });

    it('maps a transport failure to network', async () => {
      const { api, module } = setup();
      api.fail('createKey', new OpenRouterApiError('fetch failed', { network: true }));

      const result = await module.open('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('network');
    });

    it('maps an unrecognised failure to unknown', async () => {
      const { api, module } = setup();
      api.fail('createKey', new Error('something odd'));

      const result = await module.open('issue-1');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown');
    });

    it('does not record a budget when key creation fails', async () => {
      const { api, module } = setup();
      api.fail('createKey', new OpenRouterApiError('Unauthorized', { statusCode: 401 }));

      await module.open('issue-1');
      const status = await module.status('issue-1');

      expect(status.ok).toBe(false);
      if (status.ok) return;
      expect(status.error.kind).toBe('not-open');
    });
  });
});
