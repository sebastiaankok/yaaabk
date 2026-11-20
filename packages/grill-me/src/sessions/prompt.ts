import { DEFAULT_OPENCODE_MODEL, resolveOpenCodeModel, type ProjectMode } from '@yaaabk/shared';

/** Default OpenCode model when neither the request nor the Project chooses one. */
export const DEFAULT_GRILL_MODEL = DEFAULT_OPENCODE_MODEL;

/** Resolves the model a session should use. */
export function resolveSessionModel(
  requested: string | undefined,
  fallback: string = process.env['YAAABK_DEFAULT_MODEL'] ?? DEFAULT_GRILL_MODEL,
): string {
  return resolveOpenCodeModel(requested, fallback);
}

/** The skill the agent must load before it talks to the Developer. */
export const GRILL_SKILL_ID = 'grill-me';

export interface GrillSessionPromptInput {
  projectId: string;
  projectName: string;
  idea: string;
  mode: ProjectMode;
  model: string;
  activePlan?: string | null;
  repoFullName?: string | null;
}

/** The opening prompt that hands the Developer's idea to the grill-me agent. */
export function buildGrillSessionPrompt(input: GrillSessionPromptInput): string {
  const lines = [
    'You are the YAAABK grill-me agent, running in a live terminal session.',
    '',
    `Before anything else, load the \`${GRILL_SKILL_ID}\` skill with the \`skill\` tool (skill id: \`${GRILL_SKILL_ID}\`). Follow it. Do not ask the Developer anything until you have loaded it.`,
    `The skill interviews the Developer one question at a time, confirms when the plan is settled, and hands off to \`to-prd\` and then \`to-issues\`. The Developer can say "write the Plan now" at any point to skip the remaining questions.`,
    'This prompt can be replayed when the terminal reconnects. If the conversation already contains earlier turns, resume it and continue from the last question. Do not restart the interview, re-ask settled questions or repeat your opening summary.',
    '',
    `Project: ${input.projectName} (${input.projectId})`,
    `Mode: ${input.mode}`,
    `Model: ${input.model}`,
  ];
  if (input.repoFullName !== undefined && input.repoFullName !== null) {
    lines.push(`Repository: ${input.repoFullName}`);
  }
  lines.push(
    '',
    'You are running inside a Pod in the Project Namespace with the cloned repository in your workspace. When a question can be answered by reading the code or by inspecting the running workloads, inspect it instead of asking the Developer. Use read-only `kubectl` for pods, logs, deployments, services, configmaps, events and HTTPRoutes. You cannot read Secrets and you must not change the cluster.',
  );
  lines.push('', "The Developer's idea:", '"""', input.idea.trim(), '"""');
  if (
    input.activePlan !== undefined &&
    input.activePlan !== null &&
    input.activePlan.trim() !== ''
  ) {
    lines.push(
      '',
      'This Project already has an active Plan. Treat it as context for the next iteration, not as a settled specification:',
      '"""',
      input.activePlan.trim(),
      '"""',
    );
  }
  return lines.join('\n');
}
