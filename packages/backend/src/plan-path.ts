import { planDocumentPath, type PlansModule } from '@yaaabk/plans';

/**
 * Builds the resolver the Issue mirror uses to link each GitHub Issue back to
 * the Plan that produced it.
 *
 * `@yaaabk/github` only knows a Plan's internal id; the backend owns the Plans
 * Module, so it translates that id into the decision record's path.
 */
export function createPlanPathResolver(
  plans: PlansModule,
): (projectId: string, planId: string) => Promise<string | null> {
  return async (projectId, planId) => {
    const listed = await plans.list(projectId);
    if (!listed.ok) return null;
    const plan = listed.value.find((candidate) => candidate.id === planId);
    return plan === undefined ? null : planDocumentPath(plan.version);
  };
}
