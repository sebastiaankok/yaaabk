import { describe, expect, it } from 'vitest';
import { hasErrors, validateExportTarget } from './export-project';

describe('validateExportTarget', () => {
  it('accepts a username and keeps the project name when no repo name is given', () => {
    const errors = validateExportTarget({ owner: 'dev', repoName: '' });

    expect(errors).toEqual({});
    expect(hasErrors(errors)).toBe(false);
  });

  it('requires a GitHub username', () => {
    const errors = validateExportTarget({ owner: '   ', repoName: '' });

    expect(errors.owner).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });

  it('rejects a username that is not a GitHub-friendly slug', () => {
    const errors = validateExportTarget({ owner: 'Dev_O!', repoName: '' });

    expect(errors.owner).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });

  it('accepts an explicit repo name that is a valid slug', () => {
    const errors = validateExportTarget({ owner: 'dev', repoName: 'my-todo' });

    expect(errors).toEqual({});
    expect(hasErrors(errors)).toBe(false);
  });

  it('rejects an invalid repo name', () => {
    const errors = validateExportTarget({ owner: 'dev', repoName: 'My Todo' });

    expect(errors.repoName).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });
});
