import type { AgentConfig } from './config';
import type { AgentIssue } from './ports';

/**
 * Builds the prompt handed to OpenCode for one Issue.
 *
 * Kept pure and small so the wording can be asserted in tests; the actual
 * implementation instructions live in the `implement-issue` OpenCode skill the
 * image ships, which the prompt points OpenCode at.
 */
export function buildImplementPrompt(issue: AgentIssue, config: AgentConfig): string {
  return [
    `Implement GitHub issue #${issue.number}: ${issue.title}`,
    '',
    'Use the implement-issue skill. Work in the checked-out repository:',
    '- Explore the codebase and implement the change the Issue describes.',
    '- Run the pre-commit hooks (lint, type-check, test) and fix any failures.',
    '- Do not open a pull request yourself; YAAABK does that once you finish.',
    '',
    `Repository: ${config.repoUrl}`,
    '',
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

/** Where the review Agent writes its verdict for the runner to post. */
export const REVIEW_VERDICT_PATH = '.yaaabk/review.json';

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
    'Use the review-pr skill. Work in the checked-out pull request branch:',
    '- Explore the codebase and judge whether the change delivers the Issue.',
    '- Reference the specific files and lines you are concerned about.',
    '- Do not modify, commit or push anything; you are reviewing, not implementing.',
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
    `\`${REVIEW_VERDICT_PATH}\` in the working directory as JSON:`,
    '{"event": "approve" | "request-changes", "body": "<your written summary>"}',
    '',
    'Approve only when the change is correct, complete and consistent with the',
    'Issue. Request changes when something must be fixed before it can merge.',
  ].join('\n');
}
