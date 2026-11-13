import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_NAME_LENGTH, isValidProjectName } from './project';

describe('isValidProjectName', () => {
  it('accepts lowercase, hyphen-separated names starting with a letter', () => {
    expect(isValidProjectName('todo-app')).toBe(true);
    expect(isValidProjectName('a')).toBe(true);
    expect(isValidProjectName('app2')).toBe(true);
    expect(isValidProjectName('my-todo-app-3')).toBe(true);
  });

  it('rejects names that are not GitHub-friendly slugs', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('Todo-App')).toBe(false);
    expect(isValidProjectName('1todo')).toBe(false);
    expect(isValidProjectName('-todo')).toBe(false);
    expect(isValidProjectName('todo-')).toBe(false);
    expect(isValidProjectName('todo--app')).toBe(false);
    expect(isValidProjectName('todo_app')).toBe(false);
    expect(isValidProjectName('todo app')).toBe(false);
  });

  it('accepts a name exactly at the length limit and rejects one beyond it', () => {
    expect(isValidProjectName('a'.repeat(MAX_PROJECT_NAME_LENGTH))).toBe(true);
    expect(isValidProjectName('a'.repeat(MAX_PROJECT_NAME_LENGTH + 1))).toBe(false);
  });
});
