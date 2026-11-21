import type { OverviewPlan } from '@yaaabk/stats';

export type NextActionId = 'start-plan' | 'review-plan';

/** The single primary action a Project overview offers a Developer. */
export interface NextAction {
  id: NextActionId;
  label: string;
  detail: string;
}

/**
 * Resolves the one action that moves a Project forward: publish a first Plan or
 * review the Plan waiting for acceptance. An accepted Plan needs no action: the
 * project tabs already lead to its Issues.
 * The page turns the id into a route so the model stays free of URL building.
 */
export function nextAction(activePlan: OverviewPlan | null): NextAction | null {
  if (activePlan !== null && activePlan.acceptedAt === null) {
    return {
      id: 'review-plan',
      label: `Review Plan v${activePlan.version}`,
      detail: `Plan v${activePlan.version} is waiting for review. Accept it to publish its Issues to GitHub.`,
    };
  }

  if (activePlan !== null) {
    return null;
  }

  return {
    id: 'start-plan',
    label: 'Start a Plan',
    detail: 'No Plan yet. Open a Grill-Me Session to turn your idea into a Plan and Issues.',
  };
}
