import { randomUUID } from 'node:crypto';
import { consoleLogger, issuesError, toIssuesError, type IssuesLogger } from './errors';
import { buildIssueGraph } from './graph';
import {
  isIssueLabel,
  isIssueStatus,
  type Issue,
  type IssueLabel,
  type IssuePatch,
  type IssueStore,
  type IssuesModule,
  type IssuesResult,
  type NewIssue,
} from './types';

/** The default per-Issue OpenRouter budget, in whole cents. */
export const DEFAULT_BUDGET_CENTS = 50;
/** The largest per-Issue budget a Developer may set, in whole cents. */
export const MAX_BUDGET_CENTS = 500;
/** The default cap on Agent attempts before an Issue needs a human. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface IssuesModuleOptions {
  store: IssueStore;
  /** Injectable clock. Defaults to `Date`. */
  clock?: () => Date;
  /** Injectable id generator. Defaults to `crypto.randomUUID`. */
  ids?: () => string;
  /** Per-Issue budget applied when a command does not set one. */
  defaultBudgetCents?: number;
  /** Agent attempt cap applied when a command does not set one. */
  maxAttempts?: number;
  logger?: IssuesLogger;
}

/** Returns whether `value` is a whole number of cents in the allowed range. */
function isValidBudget(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_BUDGET_CENTS
  );
}

function isValidAttempts(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Returns a human-readable reason the input is not a valid new Issue, if any. */
function invalidReason(input: NewIssue): string | undefined {
  if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
    return 'A project id is required';
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return 'An issue title is required';
  }
  if (input.label !== undefined && !isIssueLabel(input.label)) {
    return `"${String(input.label)}" is not a valid issue label`;
  }
  if (input.dependsOn !== undefined && !isStringArray(input.dependsOn)) {
    return 'Dependencies must be a list of issue titles';
  }
  if (input.budgetCents !== undefined && !isValidBudget(input.budgetCents)) {
    return `The budget must be whole cents between 1 and ${MAX_BUDGET_CENTS}`;
  }
  if (input.maxAttempts !== undefined && !isValidAttempts(input.maxAttempts)) {
    return 'The attempt cap must be a positive whole number';
  }
  return undefined;
}

/** Returns a human-readable reason the patch is not valid, if any. */
function patchReason(patch: IssuePatch): string | undefined {
  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim() === '')) {
    return 'An issue title is required';
  }
  if (patch.body !== undefined && typeof patch.body !== 'string') {
    return 'The issue body must be text';
  }
  if (patch.status !== undefined && !isIssueStatus(patch.status)) {
    return `"${String(patch.status)}" is not a valid issue status`;
  }
  if (patch.label !== undefined && !isIssueLabel(patch.label)) {
    return `"${String(patch.label)}" is not a valid issue label`;
  }
  if (patch.dependsOn !== undefined && !isStringArray(patch.dependsOn)) {
    return 'Dependencies must be a list of issue titles';
  }
  if (patch.budgetCents !== undefined && !isValidBudget(patch.budgetCents)) {
    return `The budget must be whole cents between 1 and ${MAX_BUDGET_CENTS}`;
  }
  if (patch.maxAttempts !== undefined && !isValidAttempts(patch.maxAttempts)) {
    return 'The attempt cap must be a positive whole number';
  }
  return undefined;
}

/** Picks the first recognised label the skill emitted, else a draft label. */
function coerceLabel(labels: string[]): IssueLabel {
  for (const label of labels) {
    if (isIssueLabel(label)) {
      return label;
    }
  }
  return 'refinement-needed';
}

/** Builds the public Issues Module. */
export function createIssuesModule(options: IssuesModuleOptions): IssuesModule {
  const { store } = options;
  const logger = options.logger ?? consoleLogger;
  const now = options.clock ?? (() => new Date());
  const newId = options.ids ?? randomUUID;
  const defaultBudgetCents = options.defaultBudgetCents ?? DEFAULT_BUDGET_CENTS;
  const defaultMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  function materialise(input: NewIssue, id: string): Issue {
    return {
      id,
      projectId: input.projectId,
      planId: input.planId ?? null,
      githubNumber: null,
      githubSyncedAt: null,
      title: input.title.trim(),
      body: input.body ?? '',
      status: 'open',
      label: input.label ?? 'ready',
      dependsOn: [...(input.dependsOn ?? [])],
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? defaultMaxAttempts,
      budgetCents: input.budgetCents ?? defaultBudgetCents,
      openrouterKeyHash: null,
      closedAt: null,
      createdAt: now().toISOString(),
    };
  }

  /**
   * Runs an operation, mapping failures to typed errors and logging every
   * attempt for auditability.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<IssuesResult<T>> {
    try {
      const value = await run();
      logger.info(`issues ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toIssuesError(operation, error);
      logger.error(`issues ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  function requireIssue(projectId: string, issueId: string): Issue {
    const issue = store.get(projectId, issueId);
    if (issue === undefined) {
      throw issuesError('not-found', `No issue with id "${issueId}" for project "${projectId}"`);
    }
    return issue;
  }

  return {
    create(input) {
      return guard('create', { projectId: input.projectId }, async () => {
        const reason = invalidReason(input);
        if (reason !== undefined) {
          throw issuesError('invalid-input', reason);
        }
        const issue = materialise(input, newId());
        store.create(issue);
        return issue;
      });
    },

    replaceForPlan(projectId, planId, generated) {
      return guard('replaceForPlan', { projectId, planId, count: generated.length }, async () => {
        if (typeof projectId !== 'string' || projectId.trim() === '') {
          throw issuesError('invalid-input', 'A project id is required');
        }
        if (typeof planId !== 'string' || planId.trim() === '') {
          throw issuesError('invalid-input', 'A plan id is required');
        }
        for (const [index, item] of generated.entries()) {
          if (typeof item.title !== 'string' || item.title.trim() === '') {
            throw issuesError('invalid-input', `Generated issue at index ${index} has no title`);
          }
        }

        // Drop the Plan's previous drafts so repeated emissions replace rather
        // than accumulate.
        for (const existing of store.list(projectId)) {
          if (existing.planId === planId) {
            store.delete(projectId, existing.id);
          }
        }

        return generated.map((item) => {
          const issue = materialise(
            {
              projectId,
              planId,
              title: item.title,
              body: item.body,
              label: coerceLabel(item.labels),
              dependsOn: item.depends_on,
            },
            newId(),
          );
          store.create(issue);
          return issue;
        });
      });
    },

    list(projectId) {
      return guard('list', { projectId }, async () => store.list(projectId));
    },

    get(projectId, issueId) {
      return guard('get', { projectId, issueId }, async () => requireIssue(projectId, issueId));
    },

    update(projectId, issueId, patch) {
      return guard('update', { projectId, issueId }, async () => {
        const existing = requireIssue(projectId, issueId);
        const reason = patchReason(patch);
        if (reason !== undefined) {
          throw issuesError('invalid-input', reason);
        }
        const next: Issue = {
          ...existing,
          ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.dependsOn === undefined ? {} : { dependsOn: [...patch.dependsOn] }),
          ...(patch.budgetCents === undefined ? {} : { budgetCents: patch.budgetCents }),
          ...(patch.maxAttempts === undefined ? {} : { maxAttempts: patch.maxAttempts }),
          ...(patch.githubNumber === undefined ? {} : { githubNumber: patch.githubNumber }),
          ...(patch.githubSyncedAt === undefined ? {} : { githubSyncedAt: patch.githubSyncedAt }),
          ...(patch.openrouterKeyHash === undefined
            ? {}
            : { openrouterKeyHash: patch.openrouterKeyHash }),
          ...(patch.closedAt === undefined ? {} : { closedAt: patch.closedAt }),
        };
        store.update(next);
        return next;
      });
    },

    remove(projectId, issueId) {
      return guard('remove', { projectId, issueId }, async () => {
        requireIssue(projectId, issueId);
        store.delete(projectId, issueId);
      });
    },

    approve(projectId) {
      return guard('approve', { projectId }, async () => {
        const approved = store
          .list(projectId)
          .map((issue) => ({ ...issue, label: 'ready' as const }));
        for (const issue of approved) {
          store.update(issue);
        }
        return approved;
      });
    },

    graph(projectId) {
      return guard('graph', { projectId }, async () => buildIssueGraph(store.list(projectId)));
    },
  };
}
