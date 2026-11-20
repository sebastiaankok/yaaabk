import { describe, expect, it } from 'vitest';
import { addTokenUsage, isTokenUsage, tokenUsageTotal, type TokenUsage } from './token-usage';

const USAGE: TokenUsage = {
  input: 100,
  output: 20,
  reasoning: 5,
  cache: { read: 300, write: 10 },
};

describe('isTokenUsage', () => {
  it('accepts all five non-negative integer components', () => {
    expect(isTokenUsage(USAGE)).toBe(true);
  });

  it('rejects a partial or negative object', () => {
    expect(isTokenUsage({ input: 1 })).toBe(false);
    expect(isTokenUsage({ ...USAGE, input: -1 })).toBe(false);
    expect(isTokenUsage({ ...USAGE, output: 1.5 })).toBe(false);
    expect(isTokenUsage({ ...USAGE, cache: { read: 1 } })).toBe(false);
  });
});

describe('tokenUsageTotal', () => {
  it('counts every component, cache reads and writes included', () => {
    expect(tokenUsageTotal(USAGE)).toBe(435);
  });
});

describe('addTokenUsage', () => {
  it('adds retries component-wise', () => {
    expect(addTokenUsage(USAGE, USAGE)).toEqual({
      input: 200,
      output: 40,
      reasoning: 10,
      cache: { read: 600, write: 20 },
    });
  });
});
