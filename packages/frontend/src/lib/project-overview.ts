import type { OverviewPlan } from '@yaaabk/stats';

export type NextActionId = 'start-plan' | 'review-plan' | 'issue-board';

/** The single primary action a Project overview offers a Developer. */
export interface NextAction {
  id: NextActionId;
  label: string;
  detail: string;
}

/**
 * Resolves the one action that moves a Project forward: publish a first Plan,
 * review the Plan waiting for acceptance, or work the accepted Plan's Issues.
 * The page turns the id into a route so the model stays free of URL building.
 */
export function nextAction(activePlan: OverviewPlan | null): NextAction {
  if (activePlan !== null && activePlan.acceptedAt === null) {
    return {
      id: 'review-plan',
      label: `Review Plan v${activePlan.version}`,
      detail: `Plan v${activePlan.version} is waiting for review. Accept it to publish its Issues to GitHub.`,
    };
  }

  if (activePlan !== null) {
    return {
      id: 'issue-board',
      label: 'Open the issue board',
      detail: `Plan v${activePlan.version} is accepted. Follow the Issues its Agents are working on.`,
    };
  }

  return {
    id: 'start-plan',
    label: 'Start a Plan',
    detail: 'No Plan yet. Open a Grill-Me Session to turn your idea into a Plan and Issues.',
  };
}
