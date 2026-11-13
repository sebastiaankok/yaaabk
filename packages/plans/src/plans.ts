import { randomUUID } from 'node:crypto';
import { isSkillLevel } from '@yaaabk/shared';
import { consoleLogger, plansError, toPlansError, type PlansLogger } from './errors';
import type { NewPlan, Plan, PlanStore, PlansModule, PlansResult } from './types';

export interface PlansModuleOptions {
  store: PlanStore;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  ids?: () => string;
  logger?: PlansLogger;
}

/** Returns a human-readable reason the input is not a valid Plan, if any. */
function invalidReason(input: NewPlan): string | undefined {
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
    return 'A project id is required';
  }
  if (typeof input.contentMarkdown !== 'string' || input.contentMarkdown.trim() === '') {
    return 'Plan content is required';
  }
  if (!isSkillLevel(input.skillLevel)) {
    return `"${input.skillLevel}" is not a valid skill level`;
  }
  if (input.source !== 'grill-me' && input.source !== 'upload') {
    return `"${input.source}" is not a valid plan source`;
  }
  return undefined;
}

/** Builds the public Plans Module. */
export function createPlansModule(options: PlansModuleOptions): PlansModule {
  const { store } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const newId = options.ids ?? randomUUID;

  /**
   * Runs an operation, mapping failures to typed errors and logging every
   * attempt for auditability.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<PlansResult<T>> {
    try {
      const value = await run();
      logger.info(`plans ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toPlansError(operation, error);
      logger.error(`plans ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  return {
    create(input) {
      return guard('create', { projectId: input.projectId }, async () => {
        const reason = invalidReason(input);
        if (reason !== undefined) {
          throw plansError('invalid-input', reason);
        }

        const plan: Plan = {
          id: newId(),
          projectId: input.projectId,
          version: store.nextVersion(input.projectId),
          contentMarkdown: input.contentMarkdown,
          skillLevel: input.skillLevel,
          source: input.source,
          createdAt: now().toISOString(),
          isActive: true,
        };
        store.create(plan);
        return plan;
      });
    },

    list(projectId) {
      return guard('list', { projectId }, async () => store.list(projectId));
    },

    getActive(projectId) {
      return guard('getActive', { projectId }, async () => store.getActive(projectId) ?? null);
    },

    activate(projectId, planId) {
      return guard('activate', { projectId, planId }, async () => {
        store.activate(projectId, planId);
        const plan = store.get(projectId, planId);
        if (plan === undefined) {
          throw plansError('not-found', `No plan with id "${planId}" for project "${projectId}"`);
        }
        return plan;
      });
    },
  };
}
