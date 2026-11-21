import type { ProjectMode } from '@yaaabk/shared';

const PROJECT_MODE_LABELS: Record<ProjectMode, string> = {
  guided: 'Guided',
  autonomous: 'Autonomous',
};

const PROJECT_MODE_HINTS: Record<ProjectMode, string> = {
  guided:
    'The agent interviews you one question at a time, then checks the module sketch and issue breakdown with you.',
  autonomous:
    'The agent decides everything itself and only shows you the finished Plan and Issues.',
};

/** The humanised name a Project mode shows in the UI. */
export function projectModeLabel(mode: ProjectMode): string {
  return PROJECT_MODE_LABELS[mode];
}

/** A one-sentence explanation of how the agent works in a Project mode. */
export function projectModeHint(mode: ProjectMode): string {
  return PROJECT_MODE_HINTS[mode];
}
