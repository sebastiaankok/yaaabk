import type { SkillLevel } from '@yaaabk/shared';

/** Default OpenCode model when neither the request nor the Project chooses one. */
export const DEFAULT_GRILL_MODEL = 'openrouter/anthropic/claude-sonnet-4.5';

/** Resolves the model a session should use. */
export function resolveSessionModel(
  requested: string | undefined,
  fallback: string = process.env['YAAABK_DEFAULT_MODEL'] ?? DEFAULT_GRILL_MODEL,
): string {
  const trimmed = requested?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : fallback;
}

/** How question depth changes with the Developer's skill level. */
const DEPTH_GUIDANCE: Record<SkillLevel, string> = {
  beginner:
    'The Developer is a beginner. Ask one simple, concrete question at a time and briefly explain any jargon you use.',
  expert:
    'The Developer is an expert. Ask one deep question at a time, name trade-offs, and state opinionated defaults you would recommend.',
};

export interface GrillSessionPromptInput {
  projectId: string;
  projectName: string;
  idea: string;
  skillLevel: SkillLevel;
  model: string;
  activePlan?: string | null;
  repoFullName?: string | null;
}

/** The opening prompt that hands the Developer's idea to the grill-me agent. */
export function buildGrillSessionPrompt(input: GrillSessionPromptInput): string {
  const lines = [
    'You are the YAAABK grill-me agent, running in a live terminal session.',
    '',
    `Project: ${input.projectName} (${input.projectId})`,
    `Developer skill level: ${input.skillLevel}`,
    `Model: ${input.model}`,
    DEPTH_GUIDANCE[input.skillLevel],
  ];
  if (input.repoFullName !== undefined && input.repoFullName !== null) {
    lines.push(`Repository: ${input.repoFullName}`);
  }
  lines.push(
    '',
    'Refine the idea below into a concrete plan. Interview the Developer one question at a time.',
    'Do not batch questions. When you have no more questions, confirm the plan is settled.',
    '',
    "The Developer's idea:",
    '"""',
    input.idea.trim(),
    '"""',
  );
  if (
    input.activePlan !== undefined &&
    input.activePlan !== null &&
    input.activePlan.trim() !== ''
  ) {
    lines.push(
      '',
      'This Project already has an active plan. Treat it as context for the next iteration:',
      '"""',
      input.activePlan.trim(),
      '"""',
    );
  }
  return lines.join('\n');
}
