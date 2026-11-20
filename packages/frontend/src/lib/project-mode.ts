import type { ProjectMode } from '@yaaabk/shared';

const PROJECT_MODE_LABELS: Record<ProjectMode, string> = {
  guided: 'Guided',
  autonomous: 'Autonomous',
};

/** The humanised name a Project mode shows in the UI. */
export function projectModeLabel(mode: ProjectMode): string {
  return PROJECT_MODE_LABELS[mode];
}
