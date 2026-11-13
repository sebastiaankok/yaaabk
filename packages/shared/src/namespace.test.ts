import { describe, expect, it } from 'vitest';
import { PROJECT_NAMESPACE_PREFIX, projectNamespace } from './namespace';

describe('projectNamespace', () => {
  it('derives a short namespace from a full uuid', () => {
    expect(projectNamespace('a1b2c3d4-0000-4000-8000-000000000000')).toBe('project-a1b2c3d4');
  });

  it('takes the first eight hex characters, ignoring separators', () => {
    expect(projectNamespace('a1b2c3d4e5f6a7b8')).toBe('project-a1b2c3d4');
  });

  it('exposes the prefix used for every project namespace', () => {
    expect(PROJECT_NAMESPACE_PREFIX).toBe('project-');
  });

  it('rejects ids that are too short to derive a namespace from', () => {
    expect(() => projectNamespace('abc')).toThrow(/at least 8/i);
  });
});
