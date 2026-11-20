import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './config';
import type { AgentIssue } from './ports';
import { buildImplementPrompt, buildResolveConflictsPrompt, buildReviewPrompt } from './prompt';

const ISSUE: AgentIssue = { number: 42, title: 'Add login', body: 'With OAuth.' };

const CONFIG: AgentConfig = {
  kind: 'implement-issue',
  issueNumber: 42,
  repoUrl: 'https://github.com/acme/todo-app',
  githubToken: 'gh-token',
  openrouterApiKey: 'sk-or-key',
  maxAttempts: 3,
};

/** Reads the `name` from a bundled skill's frontmatter. */
function skillName(id: string): string {
  const path = fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url));
  const source = readFileSync(path, 'utf8');
  const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (name === undefined) throw new Error(`${id} has no frontmatter name`);
  return name;
}

describe('the bundled Agent skills', () => {
  it('name each skill after the ID its prompt asks OpenCode to load', () => {
    expect(skillName('implement-issue')).toBe('implement-issue');
    expect(skillName('review-pr')).toBe('review-pr');
    expect(skillName('resolve-conflicts')).toBe('resolve-conflicts');
  });

  it('uses the skill IDs the prompts name', () => {
    expect(buildImplementPrompt(ISSUE, CONFIG)).toContain('Use the implement-issue skill');
    expect(
      buildReviewPrompt(ISSUE, { pullNumber: 7, branch: 'agent/issue-42', diff: '' }),
    ).toContain('Use the review-pr skill');
    expect(
      buildResolveConflictsPrompt(ISSUE, {
        pullNumber: 7,
        branch: 'agent/issue-42',
        paths: [],
        mergeOutput: '',
      }),
    ).toContain('Use the resolve-conflicts skill');
  });
});
