import { describe, expect, it } from 'vitest';
import { runLabel } from './agent-run';

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
