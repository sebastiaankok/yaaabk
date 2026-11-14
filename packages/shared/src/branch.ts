/**
 * The naming convention for the branch an Agent works an Issue on.
 *
 * Shared because two Modules on opposite sides of the GitHub boundary depend on
 * it: `@yaaabk/agent` creates the branch, and `@yaaabk/ci-tracker` reads it back
 * to map a pull request to the Issue it implements.
 */

/** The branch an Issue's Agent pushes to, e.g. `agent/issue-42`. */
export function issueBranch(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

/** The branch prefix, so a parse never mistakes another `agent/...` ref. */
const BRANCH_PREFIX = 'agent/issue-';

/**
 * Reads the Issue number back out of an Agent's branch.
 *
 * Returns `null` for anything that is not exactly an `agent/issue-<n>` ref, so
 * a pull request from another branch is never mistaken for an Issue's work.
 */
export function issueNumberFromBranch(branch: string): number | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const suffix = branch.slice(BRANCH_PREFIX.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  return Number(suffix);
}
