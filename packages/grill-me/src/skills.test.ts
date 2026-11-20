import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Reads a bundled skill by its OpenCode id (the directory name). */
function readSkill(id: string): string {
  return readFileSync(fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url)), 'utf8');
}

/** Reads a repository file relative to its root. */
function readRepoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
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

  it('reads the Project mode from the opening prompt', () => {
    expect(skill).toMatch(/project mode/i);
    expect(skill).not.toMatch(/skill level/i);
    expect(skill).not.toContain('beginner');
    expect(skill).not.toContain('expert');
  });

  it('has a Mode section for both Project modes', () => {
    expect(skill).toMatch(/^## Mode$/m);
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/guided/i);
  });

  it('skips the interview entirely in autonomous mode', () => {
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/never ask|do not ask/i);
    expect(skill).toMatch(/recommended option/i);
    expect(skill).toMatch(/settled/i);
    expect(skill).toMatch(/hand off automatically|hand off without asking/i);
    expect(skill).toMatch(/module sketch/i);
    expect(skill).toMatch(/issue breakdown/i);
  });

  it('keeps the one-question loop and all three confirmations in guided mode', () => {
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/one (deep )?question at a time/i);
    expect(skill).toMatch(/recommended option/i);
    expect(skill).toMatch(/jargon/i);
    expect(skill).toMatch(/plan/i);
    expect(skill).toMatch(/module sketch/i);
    expect(skill).toMatch(/issue breakdown/i);
    expect(skill).toMatch(/confirm/i);
  });

  it('treats a missing mode as guided', () => {
    expect(skill).toMatch(/missing mode|mode is missing|no mode/i);
    expect(skill).toMatch(/behaves? as guided|treat .* as guided/i);
  });

  it('adopts instructions the Developer types in autonomous mode without follow-ups', () => {
    expect(skill).toMatch(/instruction the Developer types/i);
    expect(skill).toMatch(/without asking follow-ups|without a follow-up/i);
  });

  it('keeps Finish manual in both modes', () => {
    expect(skill).toMatch(/finish/i);
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/draft/i);
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
    expect(skill.toLowerCase()).toContain('write the plan now');
    expect(skill.toLowerCase()).not.toContain('write the prd now');
  });

  it('treats a Developer handing over the remaining decisions as a settled plan', () => {
    expect(skill).toMatch(/you decide|fill in the (rest|answers)/i);
    expect(skill).toMatch(/settled/i);
    expect(skill).toMatch(/hand off|handoff/i);
  });

  it('uses the reporting skills rather than the legacy markers', () => {
    expect(skill).not.toContain('<QUESTION>');
    expect(skill).not.toContain('<PLAN>');
    expect(skill).not.toContain('<ISSUES>');
  });
});

describe('simple-english skill', () => {
  const skill = readSkill('simple-english');

  it('is discoverable with a description OpenCode can advertise', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('asks for short sentences, active voice and simple tenses', () => {
    expect(skill).toMatch(/short sentences/i);
    expect(skill).toMatch(/active voice/i);
    expect(skill).toMatch(/simple tenses/i);
  });

  it('keeps one word for one meaning and puts the condition before the command', () => {
    expect(skill).toMatch(/one word.{0,10}one meaning/i);
    expect(skill).toMatch(/condition before (the )?command/i);
  });

  it('defines every technical term at first use', () => {
    expect(skill).toMatch(/technical term/i);
    expect(skill).toMatch(/first use/i);
  });

  it('removes AI slop', () => {
    expect(skill).toMatch(/AI slop/i);
  });

  it('leaves code, identifiers, commands, paths and quoted errors unchanged', () => {
    for (const untouched of ['code', 'identifiers', 'commands', 'file paths', 'quoted errors']) {
      expect(skill.toLowerCase()).toContain(untouched);
    }
    expect(skill).toMatch(/do not (change|rewrite|touch)/i);
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

  it('checks its module sketch with the Developer before writing in guided mode', () => {
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/module/i);
    expect(skill).toMatch(/check|confirm|review/i);
    expect(skill).toMatch(/before writing|before you write/i);
  });

  it('records the module sketch without waiting in autonomous mode', () => {
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/module/i);
    expect(skill).toMatch(/without waiting|without a question|no question|never ask/i);
    expect(skill).toMatch(/record|write|state/i);
  });

  it('keeps the manual Finish invariant in both modes', () => {
    expect(skill).toMatch(/finish/i);
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/draft/i);
  });

  it('reports through the typed reporting tool and hands off to to-issues', () => {
    expect(skill).toContain('report_prd');
    expect(skill).toContain('to-issues');
    expect(skill).toMatch(/skill`? tool/i);
  });

  it('can be asked for at any point without more grilling', () => {
    expect(skill.toLowerCase()).toContain('write the plan now');
    expect(skill.toLowerCase()).not.toContain('write the prd now');
  });

  it('loads the simple-english skill before writing the Plan', () => {
    expect(skill).toContain('simple-english');
    expect(skill).toMatch(/before (you )?write|before writing/i);
    expect(skill).toMatch(/skill`? tool/i);
  });

  it('writes a plain summary with the Plan', () => {
    expect(skill).toMatch(/summary/i);
    expect(skill).toMatch(/one or two|two plain|plain sentences/i);
    expect(skill).toMatch(/no Markdown/i);
    expect(skill).toContain('"summary"');
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

  it('labels every generated Issue ready and leaves needs-human to escalation', () => {
    expect(skill).toContain('["ready"]');
    expect(skill).toMatch(/every Issue you report gets/i);
    expect(skill).toMatch(/do not label an Issue `needs-human`/i);
    expect(skill).toMatch(/escalat/i);
  });

  it('expresses ordering with depends_on', () => {
    expect(skill).toContain('depends_on');
    expect(skill).toMatch(/dependenc/i);
  });

  it('quizzes the Developer on granularity and dependencies before reporting in guided mode', () => {
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/quiz|ask/i);
    expect(skill).toMatch(/granularit/i);
    expect(skill).toMatch(/feedback/i);
    expect(skill).toMatch(/before reporting|then report|report_issues/i);
  });

  it('validates dependencies and reports without quizzing in autonomous mode', () => {
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/validat/i);
    expect(skill).toMatch(/dependenc/i);
    expect(skill).toMatch(/without .*quiz|no question|never ask|without waiting/i);
    expect(skill).toContain('report_issues');
  });

  it('keeps the manual Finish invariant in both modes', () => {
    expect(skill).toMatch(/finish/i);
    expect(skill).toMatch(/guided/i);
    expect(skill).toMatch(/autonomous/i);
    expect(skill).toMatch(/draft/i);
  });

  it('reports the list through the typed reporting tool and explains Finish', () => {
    expect(skill).toContain('report_issues');
    expect(skill).toMatch(/finish/i);
    expect(skill).toMatch(/draft/i);
  });

  it('loads the simple-english skill before writing titles, summaries and bodies', () => {
    expect(skill).toContain('simple-english');
    expect(skill).toMatch(/titles/i);
    expect(skill).toMatch(/summaries/i);
    expect(skill).toMatch(/bodies/i);
    expect(skill).toMatch(/before (you )?write|before writing/i);
    expect(skill).toMatch(/skill`? tool/i);
  });

  it('gives every reported Issue a plain summary', () => {
    expect(skill).toMatch(/plain sentences|plain English|one or two/i);
    expect(skill).toMatch(/no Markdown/i);
    expect(skill).toMatch(/`summary`/i);
    expect(skill).toMatch(/200 characters|at most 200/i);
  });
});

describe('generated Issue labels', () => {
  it('supersedes the visual-checks ADR so generated Issues stay ready', () => {
    const oldAdr = readRepoFile('docs/adr/0002-visual-checks-are-human-in-the-loop.md');
    const adr = readRepoFile('docs/adr/0003-generated-issues-are-always-ready.md');

    expect(oldAdr).toMatch(/\*\*Status:\*\* Superseded by \[?0003/);
    expect(adr).toMatch(/^# 0003:/m);
    expect(adr).toMatch(/\*\*Status:\*\* Accepted/);
    expect(adr).toMatch(/every generated Issue|always `?ready/i);
    expect(adr).toContain('`needs-human`');
  });

  it('keeps executable-check guidance without relabelling', () => {
    const skill = readSkill('to-issues');

    expect(skill).toMatch(/executable acceptance check/i);
    expect(skill).toMatch(/visual|screenshot/i);
    expect(skill).toContain('docs/adr/0003-generated-issues-are-always-ready.md');
  });

  it('validates every ready Issue before report_issues', () => {
    const skill = readSkill('to-issues');

    expect(skill).toMatch(/before (you call )?`?report_issues`?/i);
    expect(skill).toMatch(/validation/i);
    expect(skill).toMatch(/runnable command/i);
    expect(skill).toMatch(/expected result/i);
    expect(skill).toMatch(/keep the label `ready`/i);
    expect(skill).not.toMatch(/relabel|change the label/i);
  });

  it('carries an Issue body template with a runnable acceptance check', () => {
    const skill = readSkill('to-issues');

    expect(skill).toMatch(/^## Acceptance criteria$/m);
    expect(skill).toMatch(/- \[ \] `.+` .+/);
    expect(skill).not.toMatch(/confirm visually|read the page|tab through/i);
  });
});

describe('skill packaging', () => {
  it('copies the simple-english skill into the backend and agent images', () => {
    for (const dockerfile of ['packages/backend/Dockerfile', 'packages/agent/Dockerfile']) {
      expect(readRepoFile(dockerfile)).toContain(
        '/app/packages/grill-me/skills/simple-english ./grill-skills/simple-english',
      );
    }
  });

  it('lists the simple-english skill in the grill-me README', () => {
    expect(readRepoFile('packages/grill-me/README.md')).toMatch(/`simple-english`/);
  });
});
