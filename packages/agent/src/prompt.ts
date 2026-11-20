import type { AgentConfig } from './config';
import type { AgentIssue } from './ports';

/**
 * The directory the Job clones the repository into and the Agent works in.
 *
 * `/app` is the harness (the agent runtime and its skills), never the checkout,
 * so every prompt names this absolute path instead of relying on the Agent's
 * working directory.
 */
export const REPOSITORY_DIRECTORY = '/work/repo';

/** Where the review Agent writes its verdict, relative to the checkout. */
export const REVIEW_VERDICT_FILE = '.yaaabk/review.json';

/** The absolute verdict path the review prompt names. */
export const REVIEW_VERDICT_PATH = `${REPOSITORY_DIRECTORY}/${REVIEW_VERDICT_FILE}`;

/**
 * Builds the prompt handed to OpenCode for one Issue.
 *
 * Kept pure and small so the wording can be asserted in tests; the actual
 * implementation instructions live in the `implement-issue` OpenCode skill the
 * image ships, which the prompt points OpenCode at.
 */
export function buildImplementPrompt(issue: AgentIssue, config: AgentConfig): string {
  const feedback = config.reviewFeedback?.trim();
  return [
    `Implement GitHub issue #${issue.number}: ${issue.title}`,
    '',
    `Use the implement-issue skill. Work in ${REPOSITORY_DIRECTORY}, the checked-out repository:`,
    '- Explore the codebase and implement the change the Issue describes.',
    '- Run the pre-commit hooks (lint, type-check, test) and fix any failures.',
    "- Debug the Project's running workloads with `kubectl` if needed (as the `yaaabk-agent` ServiceAccount via the auto-mounted token; never read Secret values or touch other namespaces).",
    '- Do not open a pull request yourself; YAAABK does that once you finish.',
    '',
    `The repository is at ${REPOSITORY_DIRECTORY}. /app is the harness, not the checkout:`,
    'never look for the repository in /app or search the filesystem for it.',
    '',
    `Repository: ${config.repoUrl}`,
    '',
    ...(feedback === undefined || feedback === ''
      ? []
      : ['A previous attempt was rejected. Reviewer feedback:', feedback, '']),
    'Issue body:',
    issue.body.trim() === '' ? '(no description)' : issue.body,
  ].join('\n');
}

/** Builds the pull request title for an Issue. */
export function pullRequestTitle(issue: AgentIssue): string {
  return issue.title;
}

/** Builds the pull request body, linking the Issue it closes. */
export function pullRequestBody(issue: AgentIssue): string {
  return `Implements #${issue.number}.\n\nOpened automatically by YAAABK.`;
}

/**
 * Builds the prompt handed to OpenCode when a pull request branch conflicts
 * with the base branch.
 *
 * The merge has already run and left conflict markers in the working tree, so
 * the Agent's only job is to reconcile the two changes, keep both Issues'
 * behaviour, and leave the checks green.
 */
export function buildResolveConflictsPrompt(
  issue: AgentIssue,
  conflict: { pullNumber: number; branch: string; paths: string[]; mergeOutput: string },
): string {
  return [
    `Resolve the merge conflicts on pull request #${conflict.pullNumber}: ${issue.title}`,
    '',
    `Use the resolve-conflicts skill. Work in ${REPOSITORY_DIRECTORY}, the checked-out pull request branch:`,
    '- The default branch has already been merged into this branch and left conflicts.',
    '- Resolve every conflict by preserving the intent of both sides, not by discarding one.',
    `- Conflicted files:\n${conflict.paths.map((path) => `  - ${path}`).join('\n') || '  (none reported)'}`,
    '- Do not reimplement the Issue or change unrelated code.',
    '- Run the pre-commit hooks (lint, type-check, test) and fix any failures.',
    '- Stage the resolved files so no unmerged path remains; YAAABK commits and force-pushes once you finish.',
    '- Do not push or open a pull request.',
    '',
    `The repository is at ${REPOSITORY_DIRECTORY}. /app is the harness, not the checkout:`,
    'never look for the repository in /app or search the filesystem for it.',
    '',
    `Repository: pull request branch ${conflict.branch}`,
    '',
    `Issue #${issue.number}:`,
    issue.body.trim() === '' ? '(no description)' : issue.body,
    '',
    'Merge output:',
    conflict.mergeOutput.trim() === '' ? '(no output)' : conflict.mergeOutput,
  ].join('\n');
}

/**
 * Builds the prompt handed to OpenCode for one review.
 *
 * Kept pure and small so the wording can be asserted in tests; the actual
 * instructions live in the `review-pr` OpenCode skill the image ships.
 */
export function buildReviewPrompt(
  issue: AgentIssue,
  review: { pullNumber: number; branch: string; diff: string },
): string {
  return [
    `Review GitHub pull request #${review.pullNumber}: ${issue.title}`,
    '',
    `Use the review-pr skill. Work in ${REPOSITORY_DIRECTORY}, the checked-out pull request branch:`,
    '- Explore the codebase and judge whether the change delivers the Issue.',
    '- Reference the specific files and lines you are concerned about.',
    '- Do not modify, commit or push anything; you are reviewing, not implementing.',
    '- CI has already run lint, typecheck, tests and build; trust it and do not repeat them.',
    '- Run `bun run check` at most once.',
    '- Do not start a browser, install Playwright or Chromium, or take screenshots.',
    '- Aim for 20–30 tool calls. If you exceed that budget, write the verdict with the evidence you have gathered.',
    '- Only run extra commands when a specific concern in the diff requires it.',
    '- Do not run `bun run build` unless the diff changes build configuration.',
    '- Do not inspect compiled CSS unless the Issue is specifically about build output.',
    '',
    `The repository is at ${REPOSITORY_DIRECTORY}. /app is the harness, not the checkout:`,
    'never look for the repository in /app or search the filesystem for it.',
    '',
    `Repository: pull request branch ${review.branch}`,
    '',
    `Issue #${issue.number}:`,
    issue.body.trim() === '' ? '(no description)' : issue.body,
    '',
    'Pull request diff:',
    review.diff.trim() === '' ? '(no diff)' : review.diff,
    '',
    'When you have decided, write your verdict to',
    `\`${REVIEW_VERDICT_PATH}\` as JSON:`,
    '{"event": "approve" | "request-changes", "body": "<your written summary>"}',
    '',
    'Approve only when the change is correct, complete and consistent with the',
    'Issue. Request changes when something must be fixed before it can merge.',
  ].join('\n');
}
