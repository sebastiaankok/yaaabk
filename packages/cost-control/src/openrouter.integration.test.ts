import { describe, expect, it } from 'vitest';
import { createInMemoryBudgetStore } from './budget-store';
import { createCostControlModule } from './cost-control';
import { createOpenRouterApi } from './openrouter-http';

/**
 * Exercises the module against the real OpenRouter Management API. Skipped by
 * default; run it with
 * `OPENROUTER_MANAGEMENT_KEY=... bun run test:integration`.
 *
 * It provisions a tiny real key, so it counts against OpenRouter's daily
 * key-management limit but spends no credits: nobody ever calls a model with
 * the key, and it is deleted again at the end.
 */
const enabled = process.env.YAAABK_OPENROUTER_INTEGRATION === '1';
const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY;

describe.skipIf(!enabled || managementKey === undefined)(
  'Cost Control against the real OpenRouter API',
  () => {
    const issueId = `it-${Date.now().toString(36)}`;
    const store = createInMemoryBudgetStore();
    const module = createCostControlModule({
      api: createOpenRouterApi({ managementKey: managementKey ?? '' }),
      store,
    });

    it('opens, tops up, reports status and releases a real key', async () => {
      const opened = await module.open(issueId, { budgetCents: 5 });

      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.key.startsWith('sk-or-')).toBe(true);
      expect(opened.value.keyHash.length).toBeGreaterThan(0);

      const toppedUp = await module.topUp(issueId, 10);
      expect(toppedUp.ok).toBe(true);
      if (!toppedUp.ok) return;
      expect(toppedUp.value.budgetCents).toBe(10);

      const status = await module.status(issueId);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.value.remainingCents).toBe(10);
      expect(status.value.exhausted).toBe(false);

      const released = await module.release(issueId);
      expect(released.ok).toBe(true);
      expect(await module.release(issueId)).toEqual({ ok: true, value: undefined });

      const afterRelease = await module.status(issueId);
      expect(afterRelease.ok).toBe(false);
    });
  },
);
