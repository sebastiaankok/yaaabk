import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISSUE_BUDGET_CENTS,
  DEFAULT_BUDGET_ENV,
  MANAGEMENT_KEY_ENV,
  MAX_ISSUE_BUDGET_CENTS,
  loadCostControlConfig,
} from './config';

describe('loadCostControlConfig', () => {
  it('defaults to the standard budget and no management key', () => {
    expect(loadCostControlConfig({})).toEqual({
      managementKey: undefined,
      defaultBudgetCents: DEFAULT_ISSUE_BUDGET_CENTS,
    });
  });

  it('reads the management key', () => {
    const config = loadCostControlConfig({ [MANAGEMENT_KEY_ENV]: 'sk-or-management' });

    expect(config.managementKey).toBe('sk-or-management');
  });

  it('treats a blank management key as unconfigured', () => {
    const config = loadCostControlConfig({ [MANAGEMENT_KEY_ENV]: '   ' });

    expect(config.managementKey).toBeUndefined();
  });

  it('reads a default budget override', () => {
    const config = loadCostControlConfig({ [DEFAULT_BUDGET_ENV]: '120' });

    expect(config.defaultBudgetCents).toBe(120);
  });

  it('clamps the default budget to the system ceiling', () => {
    const config = loadCostControlConfig({ [DEFAULT_BUDGET_ENV]: '9999' });

    expect(config.defaultBudgetCents).toBe(MAX_ISSUE_BUDGET_CENTS);
  });

  it('rejects a malformed default budget', () => {
    expect(() => loadCostControlConfig({ [DEFAULT_BUDGET_ENV]: 'half' })).toThrow();
    expect(() => loadCostControlConfig({ [DEFAULT_BUDGET_ENV]: '0' })).toThrow();
    expect(() => loadCostControlConfig({ [DEFAULT_BUDGET_ENV]: '12.5' })).toThrow();
  });
});
