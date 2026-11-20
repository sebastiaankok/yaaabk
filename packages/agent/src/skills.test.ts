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

/** Reads a bundled skill's markdown. */
function skillSource(id: string): string {
  const path = fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url));
  return readFileSync(path, 'utf8');
}

/** Reads the `name` from a bundled skill's frontmatter. */
function skillName(id: string): string {
  const source = skillSource(id);
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

  it('runs the project check script and does not rely on a pre-commit hook', () => {
    for (const id of ['implement-issue', 'resolve-conflicts']) {
      const source = skillSource(id).replace(/\s+/g, ' ');

      expect(source).toContain('`bun run check`');
      expect(source).not.toContain('pre-commit');
    }
  });

  it('bounds the review skill to CI and the diff', () => {
    const source = skillSource('review-pr').replace(/\s+/g, ' ');

    expect(source).toContain('CI has already run lint, typecheck, tests and build');
    expect(source).toContain('`bun run check` at most once');
    expect(source).toContain('Do not start a browser');
    expect(source).toContain('Playwright');
    expect(source).toContain('Chromium');
    expect(source).toContain('screenshots');
    expect(source).toContain('Aim for 20–30 tool calls');
    expect(source).toContain('`bun run build` unless the diff changes build configuration');
    expect(source).toContain('compiled CSS');
  });
});
