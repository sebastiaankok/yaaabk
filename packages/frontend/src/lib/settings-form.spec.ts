import { describe, expect, it } from 'vitest';
import {
  hasUnsavedChanges,
  saveBarStatus,
  toSettingsUpdate,
  validateBudgetDollars,
} from './settings-form';

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

describe('hasUnsavedChanges', () => {
  const SAVED = { githubMode: 'app' as const, defaultIssueBudgetDollars: '0.50' };

  it('reports a typed credential as an unsaved change', () => {
    expect(hasUnsavedChanges({ openrouterManagementKey: 'sk-or-v1-new' }, SAVED)).toBe(true);
  });

  it('reports a different GitHub mode as an unsaved change', () => {
    expect(hasUnsavedChanges({ githubMode: 'pat' }, SAVED)).toBe(true);
  });

  it('reports any typed GitHub credential as an unsaved change', () => {
    expect(hasUnsavedChanges({ githubPat: 'ghp_newtoken' }, SAVED)).toBe(true);
    expect(hasUnsavedChanges({ githubAppId: '12345' }, SAVED)).toBe(true);
    expect(hasUnsavedChanges({ githubPrivateKey: 'key' }, SAVED)).toBe(true);
    expect(hasUnsavedChanges({ githubInstallationId: '67890' }, SAVED)).toBe(true);
  });

  it('reports a different budget as an unsaved change', () => {
    expect(hasUnsavedChanges({ defaultIssueBudgetDollars: '1.25' }, SAVED)).toBe(true);
  });

  it('leaves the prefilled budget, blank fields and equivalent amounts alone', () => {
    expect(hasUnsavedChanges({ defaultIssueBudgetDollars: '0.50' }, SAVED)).toBe(false);
    expect(hasUnsavedChanges({ defaultIssueBudgetDollars: '0.5' }, SAVED)).toBe(false);
    expect(
      hasUnsavedChanges(
        { githubMode: 'app', githubPat: '', defaultIssueBudgetDollars: '' },
        { githubMode: 'app', defaultIssueBudgetDollars: '' },
      ),
    ).toBe(false);
  });

  it('treats an unparseable budget as unsaved so the save is refused inline', () => {
    expect(hasUnsavedChanges({ defaultIssueBudgetDollars: 'abc' }, SAVED)).toBe(true);
  });
});

describe('saveBarStatus', () => {
  it('reports a dirty form with nothing in flight as unsaved', () => {
    expect(saveBarStatus({ dirty: true, phase: 'idle' })).toBe('unsaved');
  });

  it('outranks dirtiness while a save is in flight', () => {
    expect(saveBarStatus({ dirty: true, phase: 'saving' })).toBe('saving');
  });

  it('keeps reporting a failed save', () => {
    expect(saveBarStatus({ dirty: true, phase: 'failed' })).toBe('failed');
  });

  it('reports a successful save until the next edit', () => {
    expect(saveBarStatus({ dirty: false, phase: 'saved' })).toBe('saved');
    expect(saveBarStatus({ dirty: true, phase: 'saved' })).toBe('unsaved');
  });

  it('reports a pristine form as clean', () => {
    expect(saveBarStatus({ dirty: false, phase: 'idle' })).toBe('clean');
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
