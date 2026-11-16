import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Reads a bundled skill by its OpenCode id (the directory name). */
function readSkill(id: string): string {
  return readFileSync(fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url)), 'utf8');
}

describe('grill-me skill', () => {
  const skill = readSkill('grill-me');

  it('is discoverable with a description OpenCode can advertise', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('asks exactly one question per turn and waits for the answer', () => {
    expect(skill).toMatch(/one question (per|at a time)/i);
    expect(skill).toMatch(/wait for/i);
    expect(skill).toMatch(/do not batch|never batch/i);
  });

  it('adapts question depth to the Skill Level', () => {
    expect(skill).toMatch(/skill level/i);
    expect(skill).toContain('beginner');
    expect(skill).toContain('expert');
    expect(skill).toMatch(/trade-off/i);
    expect(skill).toMatch(/jargon/i);
  });

  it('answers its own questions from the repository and cluster when it can', () => {
    expect(skill).toMatch(/repository|codebase/i);
    expect(skill).toMatch(/kubectl|cluster|workloads/i);
    expect(skill).toMatch(/instead of asking/i);
  });

  it('confirms the settled plan with the Developer before handing off', () => {
    expect(skill).toMatch(/confirm/i);
    expect(skill).toMatch(/plan is settled|settled plan/i);
    expect(skill).toMatch(/automatic|automatically/i);
    expect(skill).toContain('to-prd');
  });

  it('lets the Developer skip the rest of the interview', () => {
    expect(skill.toLowerCase()).toContain('write the prd now');
  });

  it('uses the reporting skills rather than the legacy markers', () => {
    expect(skill).not.toContain('<QUESTION>');
    expect(skill).not.toContain('<PLAN>');
    expect(skill).not.toContain('<ISSUES>');
  });
});

describe('to-prd skill', () => {
  const skill = readSkill('to-prd');

  it('is discoverable with a description OpenCode can advertise', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('produces the PRD template YAAABK Plans use', () => {
    for (const section of [
      'Problem Statement',
      'Solution',
      'User Stories',
      'Implementation Decisions',
      'Testing Decisions',
      'Out of Scope',
      'Further Notes',
    ]) {
      expect(skill).toMatch(new RegExp(section, 'i'));
    }
  });

  it('checks its module sketch with the Developer before writing', () => {
    expect(skill).toMatch(/module/i);
    expect(skill).toMatch(/check|confirm|review/i);
    expect(skill).toMatch(/before writing|before you write/i);
  });

  it('reports through the typed reporting tool and hands off to to-issues', () => {
    expect(skill).toContain('report_prd');
    expect(skill).toContain('to-issues');
    expect(skill).toMatch(/skill`? tool/i);
  });

  it('can be asked for at any point without more grilling', () => {
    expect(skill.toLowerCase()).toContain('write the prd now');
  });
});

describe('to-issues skill', () => {
  const skill = readSkill('to-issues');

  it('is discoverable with a description OpenCode can advertise', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('cuts vertical slices through the whole stack', () => {
    expect(skill).toMatch(/vertical slice/i);
    for (const layer of ['schema', 'API', 'UI', 'test']) {
      expect(skill).toMatch(new RegExp(layer, 'i'));
    }
    expect(skill).toMatch(/independently implementable|independently grabbable/i);
  });

  it('maps AFK work to ready and HITL work to needs-human', () => {
    expect(skill).toContain('`ready`');
    expect(skill).toContain('`needs-human`');
    expect(skill).toMatch(/AFK/i);
    expect(skill).toMatch(/HITL|human-in-the-loop/i);
  });

  it('expresses ordering with depends_on', () => {
    expect(skill).toContain('depends_on');
    expect(skill).toMatch(/dependenc/i);
  });

  it('quizzes the Developer on granularity and dependencies before reporting', () => {
    expect(skill).toMatch(/quiz|ask/i);
    expect(skill).toMatch(/granularit/i);
    expect(skill).toMatch(/feedback/i);
    expect(skill).toMatch(/before reporting|then report|report_issues/i);
  });

  it('reports the list through the typed reporting tool and explains Finish', () => {
    expect(skill).toContain('report_issues');
    expect(skill).toMatch(/finish/i);
    expect(skill).toMatch(/draft/i);
  });
});
