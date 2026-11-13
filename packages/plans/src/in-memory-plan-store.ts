import { plansError } from './errors';
import type { Plan, PlanStore } from './types';

/** Newest first, with id breaking ties within the same version. */
function byNewestFirst(a: Plan, b: Plan): number {
  return (
    b.version - a.version || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  );
}

/**
 * A dependency-free {@link PlanStore} for tests and for other modules that
 * need the Plans Module without a database file.
 */
export function createInMemoryPlanStore(): PlanStore {
  const plans = new Map<string, Plan>();

  return {
    create(plan) {
      for (const existing of plans.values()) {
        if (existing.projectId === plan.projectId && existing.version === plan.version) {
          throw plansError(
            'duplicate-version',
            `Plan version ${plan.version} already exists for project "${plan.projectId}"`,
          );
        }
      }

      if (plan.isActive) {
        for (const existing of plans.values()) {
          if (existing.projectId === plan.projectId && existing.isActive) {
            plans.set(existing.id, { ...existing, isActive: false });
          }
        }
      }

      plans.set(plan.id, { ...plan });
    },

    get(projectId, planId) {
      const plan = plans.get(planId);
      return plan !== undefined && plan.projectId === projectId ? { ...plan } : undefined;
    },

    list(projectId) {
      return [...plans.values()]
        .filter((plan) => plan.projectId === projectId)
        .map((plan) => ({ ...plan }))
        .sort(byNewestFirst);
    },

    getActive(projectId) {
      for (const plan of plans.values()) {
        if (plan.projectId === projectId && plan.isActive) {
          return { ...plan };
        }
      }
      return undefined;
    },

    nextVersion(projectId) {
      let max = 0;
      for (const plan of plans.values()) {
        if (plan.projectId === projectId && plan.version > max) {
          max = plan.version;
        }
      }
      return max + 1;
    },

    activate(projectId, planId) {
      const target = plans.get(planId);
      if (target === undefined || target.projectId !== projectId) {
        throw plansError('not-found', `No plan with id "${planId}" for project "${projectId}"`);
      }
      for (const plan of plans.values()) {
        if (plan.projectId === projectId) {
          plans.set(plan.id, { ...plan, isActive: plan.id === planId });
        }
      }
    },
  };
}
