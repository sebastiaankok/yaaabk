import { describe, expect, it } from 'vitest';
import { issueBranch, issueNumberFromBranch } from './branch';

describe('issueBranch', () => {
  it("names an Issue's agent branch", () => {
    expect(issueBranch(42)).toBe('agent/issue-42');
  });
});

describe('issueNumberFromBranch', () => {
  it('reads an Issue number back out of its branch', () => {
    expect(issueNumberFromBranch('agent/issue-42')).toBe(42);
  });

  it('round-trips every Issue number', () => {
    expect(issueNumberFromBranch(issueBranch(7))).toBe(7);
  });

  it('returns null for anything that is not an Issue branch', () => {
    expect(issueNumberFromBranch('main')).toBeNull();
    expect(issueNumberFromBranch('feature/agent/issue-3')).toBeNull();
    expect(issueNumberFromBranch('agent/issue-')).toBeNull();
    expect(issueNumberFromBranch('agent/issue-abc')).toBeNull();
  });
});
