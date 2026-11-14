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
