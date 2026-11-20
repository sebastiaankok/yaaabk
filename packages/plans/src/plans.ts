import { randomUUID } from 'node:crypto';
import { deriveSummary, normaliseSummary, isProjectMode } from '@yaaabk/shared';
import { consoleLogger, plansError, toPlansError, type PlansLogger } from './errors';
import type {
  NewPlan,
  Plan,
  PlanAcceptanceFacts,
  PlanStore,
  PlansModule,
  PlansResult,
} from './types';

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
  if (!isProjectMode(input.mode)) {
    return `"${String(input.mode)}" is not a valid project mode`;
  }
  if (input.source !== 'grill-me' && input.source !== 'upload') {
    return `"${input.source}" is not a valid plan source`;
  }
  return undefined;
}

/**
 * Returns why a Plan's Issue set cannot be accepted, if anything blocks it.
 *
 * Issue titles are part of the message because that is what the Developer sees
 * on the review page; the graph placement (`wave`, `missing`) comes from the
 * Issues Module.
 */
function acceptanceBlockReason(version: number, facts: PlanAcceptanceFacts): string | undefined {
  if (facts.issueCount === 0) {
    return `Plan v${version} needs at least one Issue before it can be accepted`;
  }

  const cyclic = facts.issues.filter((issue) => issue.wave === null).map((issue) => issue.title);
  if (cyclic.length > 0) {
    return `Plan v${version} has circular dependencies among: ${cyclic.join(', ')}. Break the cycle before accepting`;
  }

  const missing = facts.issues
    .filter((issue) => issue.missing.length > 0)
    .map((issue) => `${issue.title} needs ${issue.missing.join(', ')}`);
  if (missing.length > 0) {
    return `Plan v${version} has Issues with missing dependencies: ${missing.join('; ')}. Add the missing Issues before accepting`;
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

        let summary: string;
        if (input.summary === undefined || input.summary === null) {
          summary = deriveSummary(input.contentMarkdown);
        } else {
          const normalised = normaliseSummary(input.summary);
          if (!normalised.ok) {
            throw plansError('invalid-input', normalised.message);
          }
          summary = normalised.value;
        }

        const plan: Plan = {
          id: newId(),
          projectId: input.projectId,
          version: store.nextVersion(input.projectId),
          contentMarkdown: input.contentMarkdown,
          summary,
          mode: input.mode,
          source: input.source,
          createdAt: now().toISOString(),
          isActive: true,
          acceptedAt: null,
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

    accept(projectId, planId, acceptance) {
      return guard('accept', { projectId, planId }, async () => {
        const plan = store.get(projectId, planId);
        if (plan === undefined) {
          throw plansError('not-found', `No plan with id "${planId}" for project "${projectId}"`);
        }
        if (!plan.isActive) {
          throw plansError(
            'not-acceptable',
            `Only the active Plan can be accepted; activate v${plan.version} first`,
          );
        }
        if (plan.acceptedAt !== null) {
          throw plansError('not-acceptable', `Plan v${plan.version} was already accepted`);
        }

        const reason = acceptanceBlockReason(plan.version, acceptance.facts);
        if (reason !== undefined) {
          throw plansError('not-acceptable', reason);
        }

        const pushed = await acceptance.push(plan);
        if (!pushed.ok) {
          throw plansError('sync-failed', pushed.message);
        }

        const acceptedAt = now().toISOString();
        store.accept(projectId, planId, acceptedAt);
        return { ...plan, acceptedAt };
      });
    },

    removeForProject(projectId) {
      return guard('removeForProject', { projectId }, async () => {
        store.deleteForProject(projectId);
      });
    },
  };
}
