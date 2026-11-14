import { fileURLToPath } from 'node:url';
import type { SkillLevel } from '@yaaabk/shared';

/** A grill-me session is abandoned after this long. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The skill the agent must load: the in-repo `skills/grill-me`.
 * `YAAABK_GRILL_ME_SKILL` overrides it, so a deployment can point at a mounted
 * copy instead.
 */
export function defaultSkillPath(): string {
  const override = process.env['YAAABK_GRILL_ME_SKILL'];
  if (override !== undefined && override !== '') {
    return override;
  }
  return fileURLToPath(new URL('../skills/grill-me/SKILL.md', import.meta.url));
}

/** How question depth changes with the Developer's skill level. */
const DEPTH_GUIDANCE: Record<SkillLevel, string> = {
  beginner:
    'The Developer is a beginner. Ask simple, concrete questions, one at a time, and briefly explain any jargon you use.',
  expert:
    'The Developer is an expert. Ask deep architectural questions, name trade-offs, and state opinionated defaults you would recommend.',
};

export interface SessionPromptInput {
  projectId: string;
  idea: string;
  skillLevel: SkillLevel;
  skillPath: string;
}

/** The opening prompt that hands the Developer's idea to the grill-me skill. */
export function buildSessionPrompt(input: SessionPromptInput): string {
  return [
    "You are the YAAABK grill-me agent. Refine the Developer's idea into a concrete plan.",
    '',
    `Load and follow the skill at: ${input.skillPath}`,
    `Project id: ${input.projectId}`,
    `Developer skill level: ${input.skillLevel}`,
    DEPTH_GUIDANCE[input.skillLevel],
    '',
    "Follow the skill's marker protocol exactly:",
    '- ask one question at a time inside <QUESTION></QUESTION> markers;',
    '- when the plan is settled, emit the final markdown inside <PLAN></PLAN>;',
    '- then emit the issue list inside <ISSUES></ISSUES> as a JSON array of',
    '  { title, body, labels, depends_on }.',
    '',
    "The Developer's idea:",
    '"""',
    input.idea.trim(),
    '"""',
  ].join('\n');
}

/** Wraps refinement feedback so the agent revises the issue list in place. */
export function buildRefineMessage(feedback: string): string {
  return [
    'The generated issues need refinement. Feedback from the Developer:',
    '"""',
    feedback.trim(),
    '"""',
    'Respond with an updated <ISSUES></ISSUES> block only.',
  ].join('\n');
}

export interface IssuesPromptInput {
  projectId: string;
  plan: string;
  skillLevel: SkillLevel;
  skillPath: string;
  /** Revision feedback, when the run refines an existing issue list. */
  feedback?: string;
}

/** The one-shot prompt that turns a finished plan into an implementation issue list. */
export function buildIssuesPrompt(input: IssuesPromptInput): string {
  const lines = [
    'You are the YAAABK grill-me agent. Turn the finished plan below into an implementation issue list.',
    '',
    `Load and follow the skill at: ${input.skillPath}`,
    `Project id: ${input.projectId}`,
    `Developer skill level: ${input.skillLevel}`,
    DEPTH_GUIDANCE[input.skillLevel],
    '',
    'Do not ask questions. Respond with a single <ISSUES></ISSUES> block: a JSON array of',
    '{ title, body, labels, depends_on } objects. `depends_on` holds the titles of issues',
    'that must be implemented first.',
  ];
  if (input.feedback !== undefined && input.feedback.trim() !== '') {
    lines.push(
      '',
      'Revise the issue list using this feedback from the Developer:',
      '"""',
      input.feedback.trim(),
      '"""',
    );
  }
  lines.push('', 'The plan:', '"""', input.plan.trim(), '"""');
  return lines.join('\n');
}
