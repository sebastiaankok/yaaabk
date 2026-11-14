import { describe, expect, it } from 'vitest';
import { toSettingsUpdate, validateBudgetDollars } from './settings-form';

describe('validateBudgetDollars', () => {
  it('accepts dollars that map to whole cents within 1–500', () => {
    expect(validateBudgetDollars('0.50')).toBeUndefined();
    expect(validateBudgetDollars('5.00')).toBeUndefined();
    expect(validateBudgetDollars('2')).toBeUndefined();
  });

  it('rejects values that are not dollars-and-cents', () => {
    expect(validateBudgetDollars('abc')).toBeDefined();
    expect(validateBudgetDollars('-1')).toBeDefined();
    expect(validateBudgetDollars('0')).toBeDefined();
    expect(validateBudgetDollars('5.01')).toBeDefined();
    expect(validateBudgetDollars('0.005')).toBeDefined();
  });
});

describe('toSettingsUpdate', () => {
  it('sends only the fields the Developer typed, with the budget in cents', () => {
    const update = toSettingsUpdate(
      { openrouterManagementKey: 'sk-or-v1-new', defaultIssueBudgetDollars: '1.25' },
      { openrouterManagementKey: 'sk-or-…1c96' },
    );

    expect(update).toEqual({
      openrouterManagementKey: 'sk-or-v1-new',
      defaultIssueBudgetCents: 125,
    });
  });

  it('clears the credentials that are not in the active GitHub mode', () => {
    const update = toSettingsUpdate(
      { githubMode: 'pat', githubPat: 'ghp_newtoken' },
      {
        githubAppId: 'app 12345',
        githubPrivateKey: '…-key',
      },
    );

    expect(update.githubPat).toBe('ghp_newtoken');
    expect(update.clear).toEqual(['githubAppId', 'githubPrivateKey']);
  });

  it('clears the PAT when the App mode is active', () => {
    const update = toSettingsUpdate(
      {
        githubMode: 'app',
        githubAppId: '12345',
        githubPrivateKey: 'key',
        githubInstallationId: '67890',
      },
      { githubPat: 'ghp_or…1234' },
    );

    expect(update.clear).toEqual(['githubPat']);
  });

  it('sends nothing when nothing changed', () => {
    const update = toSettingsUpdate({ githubMode: 'pat' }, {});

    expect(update).toEqual({});
  });
});
