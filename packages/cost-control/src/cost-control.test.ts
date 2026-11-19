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
        limitUsd: DEFAULT_ISSUE_BUDGET_CENTS / 100,
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

  describe('attempt budget', () => {
    it('gives a first attempt the whole Issue budget without reading a prior key', async () => {
      const { api, module } = setup();

      const result = await module.beginAttempt('issue-1', { budgetCents: 200, attempt: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        issueId: 'issue-1',
        remainingCents: 200,
        spentCents: 0,
        priorKeyHash: null,
      });
      expect(api.calls).toEqual([]);
    });

    it('caps a later attempt at the budget minus what earlier attempts spent', async () => {
      const { api, module } = setup();
      const firstKey = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!firstKey.ok) throw new Error('mint failed');
      const first = await module.beginAttempt('issue-1', { budgetCents: 50, attempt: 1 });
      if (!first.ok) throw new Error('begin failed');

      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: firstKey.value.keyHash,
        spentCents: first.value.spentCents,
        expiresAt: firstKey.value.expiresAt,
        createdAt: firstKey.value.createdAt,
      });
      api.setUsage(firstKey.value.keyHash, 0.3);

      const second = await module.beginAttempt('issue-1', {
        budgetCents: 50,
        attempt: 2,
        priorKeyHash: firstKey.value.keyHash,
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toEqual({
        issueId: 'issue-1',
        remainingCents: 20,
        spentCents: 30,
        priorKeyHash: firstKey.value.keyHash,
      });
    });

    it('refuses a later attempt when the prior spend cannot be read', async () => {
      const { api, module } = setup();
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: 'hash-gone',
        spentCents: 0,
        expiresAt: THIRTY_DAYS_LATER,
        createdAt: NOW.toISOString(),
      });
      api.fail('getKey', new OpenRouterApiError('API key not found', { statusCode: 404 }));

      const result = await module.beginAttempt('issue-1', {
        budgetCents: 50,
        attempt: 2,
        priorKeyHash: 'hash-gone',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('spend-unreadable');
      expect(result.error.message).toContain('remaining budget is unknown');
      expect(result.error.message).toContain('hash-gone');
      expect(api.calls).toEqual(['getKey']);
    });

    it('refuses a later attempt when no prior key is recorded', async () => {
      const { api, module } = setup();

      const result = await module.beginAttempt('issue-1', {
        budgetCents: 50,
        attempt: 2,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('spend-unreadable');
      expect(result.error.message).toContain('no OpenRouter key');
      expect(api.calls).toEqual([]);
    });

    it('refuses another attempt once the Issue budget is spent', async () => {
      const { api, module } = setup();
      const firstKey = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!firstKey.ok) throw new Error('mint failed');
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: firstKey.value.keyHash,
        spentCents: 0,
        expiresAt: firstKey.value.expiresAt,
        createdAt: firstKey.value.createdAt,
      });
      api.setUsage(firstKey.value.keyHash, 0.5);

      const result = await module.beginAttempt('issue-1', {
        budgetCents: 50,
        attempt: 2,
        priorKeyHash: firstKey.value.keyHash,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('budget-exhausted');
      expect(result.error.message).toContain('Raise the Issue');
      expect(api.calls).toEqual(['createKey', 'getKey']);
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

    it('raises the current key only by the new cap minus earlier spend', async () => {
      const { api, module } = setup();
      const key = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!key.ok) throw new Error('mint failed');
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: key.value.keyHash,
        spentCents: 30,
        expiresAt: key.value.expiresAt,
        createdAt: key.value.createdAt,
      });

      const result = await module.topUp('issue-1', 80);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ budgetCents: 80, spentCents: 30 });
      expect(api.lastUpdate).toEqual({ hash: key.value.keyHash, input: { limitUsd: 0.5 } });
    });

    it('refuses a cap that is already spent', async () => {
      const { api, module } = setup();
      const key = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!key.ok) throw new Error('mint failed');
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: key.value.keyHash,
        spentCents: 30,
        expiresAt: key.value.expiresAt,
        createdAt: key.value.createdAt,
      });

      const result = await module.topUp('issue-1', 30);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('budget-exhausted');
      expect(api.calls).toEqual(['createKey']);
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
        budgetCents: DEFAULT_ISSUE_BUDGET_CENTS,
        usedCents: 20,
        remainingCents: DEFAULT_ISSUE_BUDGET_CENTS - 20,
        expiresAt: THIRTY_DAYS_LATER,
        disabled: false,
        exhausted: false,
      });
      expect(JSON.stringify(result.value)).not.toContain('sk-or-');
    });

    it('counts earlier attempts in the remaining budget', async () => {
      const { api, module } = setup();
      const key = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!key.ok) throw new Error('mint failed');
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: key.value.keyHash,
        spentCents: 30,
        expiresAt: key.value.expiresAt,
        createdAt: key.value.createdAt,
      });
      api.setUsage(key.value.keyHash, 0.2);

      const result = await module.status('issue-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        budgetCents: 50,
        usedCents: 50,
        remainingCents: 0,
        exhausted: true,
      });
    });

    it('marks the budget exhausted once it is spent', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');
      api.setUsage(opened.value.keyHash, DEFAULT_ISSUE_BUDGET_CENTS / 100);

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

  describe('summary', () => {
    it('reports the whole budget as remaining before an Issue has a key', async () => {
      const { api, module } = setup();

      const result = await module.summary('issue-1', 200);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        issueId: 'issue-1',
        budgetCents: 200,
        spentCents: 0,
        remainingCents: 200,
        keyOpen: false,
        exhausted: false,
      });
      expect(api.calls).toEqual([]);
    });

    it('counts earlier attempts and the open key usage against the Issue budget', async () => {
      const { api, module } = setup();
      const key = await module.mint({ subject: 'agent-issue-1-attempt-1', budgetCents: 50 });
      if (!key.ok) throw new Error('mint failed');
      await module.recordAttempt('issue-1', {
        budgetCents: 50,
        attempt: 1,
        keyHash: key.value.keyHash,
        spentCents: 30,
        expiresAt: key.value.expiresAt,
        createdAt: key.value.createdAt,
      });
      api.setUsage(key.value.keyHash, 0.2);

      const result = await module.summary('issue-1', 60);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        budgetCents: 60,
        spentCents: 50,
        remainingCents: 10,
        keyOpen: true,
        exhausted: false,
      });
    });

    it('marks an Issue exhausted once its budget is spent', async () => {
      const { api, module } = setup();
      const opened = await module.open('issue-1');
      if (!opened.ok) throw new Error('open failed');
      api.setUsage(opened.value.keyHash, 1);

      const result = await module.summary('issue-1', 100);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ spentCents: 100, remainingCents: 0, exhausted: true });
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

  describe('mint', () => {
    it('creates a budgeted key for a generic subject without recording a budget', async () => {
      const { api, module } = setup();

      const result = await module.mint({ subject: 'session-s1' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        subject: 'session-s1',
        budgetCents: DEFAULT_ISSUE_BUDGET_CENTS,
        expiresAt: THIRTY_DAYS_LATER,
        createdAt: NOW.toISOString(),
      });
      expect(result.value.key).toBe(api.created[0]?.key);
      expect(result.value.keyHash).toBe(api.created[0]?.keyInfo.hash);
      expect(api.lastCreate).toEqual({
        name: 'yaaabk-session-s1',
        limitUsd: DEFAULT_ISSUE_BUDGET_CENTS / 100,
        limitReset: null,
        expiresAt: THIRTY_DAYS_LATER,
      });
    });

    it('honours an explicit budget and lifetime', async () => {
      const { api, module } = setup();

      const result = await module.mint({
        subject: 'session-s1',
        budgetCents: 200,
        ttlMs: 4 * 60 * 60 * 1000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.budgetCents).toBe(200);
      expect(api.lastCreate?.limitUsd).toBe(2);
      expect(result.value.expiresAt).toBe(
        new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      );
    });

    it('rejects a blank subject and an out-of-range budget before calling OpenRouter', async () => {
      const { api, module } = setup();

      const blank = await module.mint({ subject: '   ' });
      const tooHigh = await module.mint({ subject: 'session-s1', budgetCents: 501 });

      expect(blank.ok).toBe(false);
      if (!blank.ok) expect(blank.error.kind).toBe('invalid-input');
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) expect(tooHigh.error.kind).toBe('budget-out-of-range');
      expect(api.calls).toEqual([]);
    });
  });

  describe('revoke', () => {
    it('deletes the key by hash', async () => {
      const { api, module } = setup();
      const minted = await module.mint({ subject: 'session-s1' });
      if (!minted.ok) throw new Error('mint failed');

      const result = await module.revoke(minted.value.keyHash);

      expect(result.ok).toBe(true);
      expect(api.calls).toEqual(['createKey', 'deleteKey']);
    });

    it('treats an already-deleted key as revoked', async () => {
      const { api, module } = setup();
      api.fail('deleteKey', new OpenRouterApiError('API key not found', { statusCode: 404 }));

      const result = await module.revoke('hash-1');

      expect(result.ok).toBe(true);
    });

    it('reports a failure to delete any other way', async () => {
      const { api, module } = setup();
      api.fail('deleteKey', new OpenRouterApiError('boom', { statusCode: 500 }));

      const result = await module.revoke('hash-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('server');
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
