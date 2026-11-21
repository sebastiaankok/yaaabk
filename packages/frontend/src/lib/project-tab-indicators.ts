import type { ProjectOverview } from '@yaaabk/stats';

/** A tab's extra fact, with the text that gives it meaning beyond colour. */
export interface ProjectTabIndicators {
  /** Set while the active Plan still waits for the Developer's acceptance. */
  review: { label: string } | null;
  /** Set while Agent runs are queued or running; never a zero badge. */
  issues: { count: number; label: string } | null;
}

/**
 * Turns a Project overview into the facts the Project tab bar carries between
 * tabs: a pending Plan review and the number of Agent runs in flight. A
 * missing overview (still loading, or a failed request) shows nothing.
 */
export function projectTabIndicators(overview: ProjectOverview | null): ProjectTabIndicators {
  if (overview === null) return { review: null, issues: null };

  const { activePlan, activeWork } = overview;
  return {
    review:
      activePlan !== null && activePlan.acceptedAt === null
        ? { label: `Plan v${activePlan.version} not accepted` }
        : null,
    issues:
      activeWork.length > 0
        ? {
            count: activeWork.length,
            label: `${activeWork.length} active agent ${activeWork.length === 1 ? 'run' : 'runs'}`,
          }
        : null,
  };
}
