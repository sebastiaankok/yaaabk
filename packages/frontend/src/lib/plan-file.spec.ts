import { describe, expect, it } from 'vitest';
import { planFilePath, planFileUrl } from './plan-file';

describe('planFilePath', () => {
  it('is the decision record path for a Plan version', () => {
    expect(planFilePath(1)).toBe('docs/plans/v1.md');
    expect(planFilePath(12)).toBe('docs/plans/v12.md');
  });
});

describe('planFileUrl', () => {
  it('links the path to the matching GitHub blob', () => {
    expect(planFileUrl('acme/todo-app', 2)).toBe(
      'https://github.com/acme/todo-app/blob/main/docs/plans/v2.md',
    );
  });

  it('keeps the owner slash in a full repository name', () => {
    expect(planFileUrl('acme/todo-app', 7)).toContain('github.com/acme/todo-app/blob/');
  });
});
