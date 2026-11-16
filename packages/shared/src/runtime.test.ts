import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENCODE_MODEL, resolveOpenCodeModel } from './runtime';

describe('resolveOpenCodeModel', () => {
  it('prefers an explicit model over the configured default', () => {
    expect(resolveOpenCodeModel('openrouter/chosen', 'openrouter/fallback')).toBe(
      'openrouter/chosen',
    );
  });

  it('falls back when the explicit model is blank', () => {
    expect(resolveOpenCodeModel('  ', 'openrouter/fallback')).toBe('openrouter/fallback');
    expect(resolveOpenCodeModel(undefined, 'openrouter/fallback')).toBe('openrouter/fallback');
  });

  it('uses the shared default when configuration chooses nothing', () => {
    expect(resolveOpenCodeModel(undefined, undefined)).toBe(DEFAULT_OPENCODE_MODEL);
  });
});
