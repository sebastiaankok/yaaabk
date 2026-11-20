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

/** The behaviour the opening prompt requires for a Project mode. */
function modeDirective(mode: ProjectMode): string {
  if (mode === 'autonomous') {
    return [
      'Mode directive (autonomous): never ask the Developer a question. At every branch pick the recommended option, state it, and continue.',
      'Treat the plan, the module sketch and the issue breakdown as settled: do not wait for confirmation at any checkpoint.',
      'Keep inspecting the repository and cluster instead of asking. Adopt any instruction the Developer types without asking follow-ups, and hand off automatically to `to-prd` and then `to-issues`.',
    ].join(' ');
  }
  return [
    'Mode directive (guided): ask one deep, trade-off-aware question at a time and wait for the answer. State the recommended option with every question and explain jargon the first time you use it.',
    'Confirm the settled plan, the module sketch and the issue breakdown with the Developer before you hand off.',
  ].join(' ');
}

/** The opening prompt that hands the Developer's idea to the grill-me agent. */
export function buildGrillSessionPrompt(input: GrillSessionPromptInput): string {
  const lines = [
    'You are the YAAABK grill-me agent, running in a live terminal session.',
    '',
    `Before anything else, load the \`${GRILL_SKILL_ID}\` skill with the \`skill\` tool (skill id: \`${GRILL_SKILL_ID}\`). Follow it. Do not ask the Developer anything until you have loaded it.`,
    `The skill turns the idea into a settled plan and hands off to \`to-prd\` and then \`to-issues\`; its Mode section decides whether it asks the Developer or decides every checkpoint itself. The Developer can say "write the Plan now" at any point to skip the remaining questions.`,
    'This prompt can be replayed when the terminal reconnects. If the conversation already contains earlier turns, resume it and continue from the last turn. Do not restart the conversation, re-ask settled points or repeat your opening summary.',
    '',
    `Project: ${input.projectName} (${input.projectId})`,
    `Mode: ${input.mode}`,
    modeDirective(input.mode),
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
      'Earlier accepted Plans are archived in `docs/plans/`. Consult them for rationale, but only the active Plan above is binding.',
    );
  }
  return lines.join('\n');
}
