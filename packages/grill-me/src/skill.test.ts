import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultSkillPath } from './config';
import { parseGeneratedIssues } from './issues';

const skillPath = defaultSkillPath();
const skill = readFileSync(skillPath, 'utf8');

/** The fenced example that demonstrates a full issues payload. */
function issuesExample(): string {
  const block = [...skill.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? '')
    .find((candidate) => candidate.includes('<ISSUES>'));
  expect(block).toBeDefined();
  return block ?? '';
}

describe('grill-me skill', () => {
  it('is bundled at the default path', () => {
    expect(skillPath).toMatch(/skills\/grill-me\/SKILL\.md$/);
    expect(existsSync(skillPath)).toBe(true);
  });

  it('documents every marker the module parses', () => {
    for (const marker of [
      '<QUESTION>',
      '</QUESTION>',
      '<PLAN>',
      '</PLAN>',
      '<ISSUES>',
      '</ISSUES>',
    ]) {
      expect(skill).toContain(marker);
    }
  });

  it('adapts its question depth to both skill levels', () => {
    expect(skill).toContain('beginner');
    expect(skill).toContain('expert');
  });

  it("ships an example that the module's issue parser accepts", () => {
    const content = /<ISSUES>\s*([\s\S]*?)\s*<\/ISSUES>/.exec(issuesExample())?.[1];
    expect(content).toBeDefined();

    const issues = parseGeneratedIssues(content ?? '');

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.title.trim() !== '')).toBe(true);
    expect(issues.some((issue) => issue.depends_on.length > 0)).toBe(true);
    expect(issues.every((issue) => issue.labels.length > 0)).toBe(true);
  });
});
