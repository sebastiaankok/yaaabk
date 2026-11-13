import { describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION_LENGTH, MAX_PROJECT_NAME_LENGTH } from '@yaaabk/shared';
import { hasErrors, validateProjectDetails } from './project-form';

describe('validateProjectDetails', () => {
  it('accepts valid details', () => {
    const errors = validateProjectDetails({ name: 'todo-app', description: 'A todo list' });

    expect(errors).toEqual({});
    expect(hasErrors(errors)).toBe(false);
  });

  it('requires a name', () => {
    const errors = validateProjectDetails({ name: '   ', description: 'A todo list' });

    expect(errors.name).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });

  it('rejects a name that is not a GitHub-friendly slug', () => {
    expect(validateProjectDetails({ name: 'Todo App', description: 'x' }).name).toBeDefined();
    expect(validateProjectDetails({ name: '1todo', description: 'x' }).name).toBeDefined();
    expect(validateProjectDetails({ name: 'todo--app', description: 'x' }).name).toBeDefined();
  });

  it('accepts a name at the length limit and rejects one beyond it', () => {
    const atLimit = 'a'.repeat(MAX_PROJECT_NAME_LENGTH);
    expect(validateProjectDetails({ name: atLimit, description: 'x' }).name).toBeUndefined();
    expect(validateProjectDetails({ name: `${atLimit}a`, description: 'x' }).name).toBeDefined();
  });

  it('requires a description', () => {
    const errors = validateProjectDetails({ name: 'todo-app', description: '  ' });

    expect(errors.description).toBeDefined();
    expect(hasErrors(errors)).toBe(true);
  });

  it('rejects a description longer than the limit', () => {
    const errors = validateProjectDetails({
      name: 'todo-app',
      description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1),
    });

    expect(errors.description).toBeDefined();
  });

  it('accepts a description exactly at the limit', () => {
    const errors = validateProjectDetails({
      name: 'todo-app',
      description: 'x'.repeat(MAX_DESCRIPTION_LENGTH),
    });

    expect(errors.description).toBeUndefined();
  });
});
