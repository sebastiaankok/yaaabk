import type { AgentRunKind } from '@yaaabk/agents';

/** Just enough of an Agent run to name it in the UI. */
export interface LabelledRun {
  kind: AgentRunKind;
  attemptNumber: number;
}

/**
 * How a run is named for a Developer, so a review or a conflict fix is not
 * mistaken for an implementation attempt.
 */
export function runLabel(run: LabelledRun): string {
  if (run.kind === 'review') return `Review ${run.attemptNumber}`;
  if (run.kind === 'resolve-conflicts') return `Conflict fix ${run.attemptNumber}`;
  if (run.kind === 'deploy') return `Deploy ${run.attemptNumber}`;
  return `Attempt ${run.attemptNumber}`;
}
