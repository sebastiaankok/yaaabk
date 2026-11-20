import { describe, expect, it } from 'vitest';
import {
  compactTokens,
  formatTokens,
  issueTokenSummary,
  runLabel,
  runTokenTotal,
} from './agent-run';

const USAGE = {
  input: 100,
  output: 20,
  reasoning: 5,
  cache: { read: 300, write: 10 },
};

describe('runLabel', () => {
  it('names an implementation attempt by its number', () => {
    expect(runLabel({ kind: 'implement-issue', attemptNumber: 2 })).toBe('Attempt 2');
  });

  it('names a review and a conflict fix by their kind and number', () => {
    expect(runLabel({ kind: 'review', attemptNumber: 1 })).toBe('Review 1');
    expect(runLabel({ kind: 'resolve-conflicts', attemptNumber: 3 })).toBe('Conflict fix 3');
  });

  it('names a deploy run as a deploy', () => {
    expect(runLabel({ kind: 'deploy', attemptNumber: 1 })).toBe('Deploy 1');
  });
});

describe('runTokenTotal', () => {
  it('counts every component of a measured run', () => {
    expect(runTokenTotal(USAGE)).toBe(435);
  });

  it('renders an unmeasured run as unknown', () => {
    expect(runTokenTotal(null)).toBeNull();
  });
});

describe('issueTokenSummary', () => {
  it('sums the model runs and marks the total partial when one is unmeasured', () => {
    expect(
      issueTokenSummary([
        { kind: 'implement-issue', tokens: USAGE },
        { kind: 'review', tokens: null },
        // Deploy runs never invoke a model, so they do not make the total partial.
        { kind: 'deploy', tokens: null },
      ]),
    ).toEqual({
      total: 435,
      partial: true,
      breakdown: { input: 100, output: 25, cached: 310 },
    });
  });

  it('returns no total when no model run could be measured', () => {
    expect(
      issueTokenSummary([
        { kind: 'implement-issue', tokens: null },
        { kind: 'deploy', tokens: null },
      ]),
    ).toEqual({ total: null, partial: true, breakdown: null });
  });

  it('reports a complete total when every model run is measured', () => {
    expect(
      issueTokenSummary([
        { kind: 'implement-issue', tokens: USAGE },
        { kind: 'resolve-conflicts', tokens: USAGE },
      ]),
    ).toEqual({
      total: 870,
      partial: false,
      breakdown: { input: 200, output: 50, cached: 620 },
    });
  });
});

describe('token formatting', () => {
  it('formats a total with thousands separators', () => {
    expect(formatTokens(19_650)).toBe('19,650');
    expect(formatTokens(null)).toBe('—');
  });

  it('compacts a run value and renders an unknown one as a dash', () => {
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(1_200)).toBe('1.2k');
    expect(compactTokens(6_550)).toBe('6.6k');
    expect(compactTokens(19_650)).toBe('19.7k');
    expect(compactTokens(1_500_000)).toBe('1.5M');
    expect(compactTokens(null)).toBe('—');
  });
});
