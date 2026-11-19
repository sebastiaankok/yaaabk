import type { CostControlError, CostControlModule, ModelCatalogue } from '@yaaabk/cost-control';
import type { IssueError, IssueLabel, IssuePatch, IssueStatus, IssuesModule } from '@yaaabk/issues';
import type { PlanError, PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asString, body, fail, projectOrResponse } from './http';
import { invalidModelField, parseAgentModel, validateAgentModel } from './model-validation';

/**
 * Issue failures map to the HTTP status the caller should act on: a malformed
 * issue is a client error, a duplicate title or an unresolved cycle is a
 * conflict, and a missing project or issue is a 404.
 */
const STATUS_BY_KIND: Record<IssueError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'duplicate-title': 409,
  'not-found': 404,
  cycle: 409,
  unknown: 500,
};

/** Plan failures, reached only when resolving the active Plan for approval. */
const PLAN_STATUS_BY_KIND: Record<PlanError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'duplicate-version': 409,
  'not-found': 404,
  unknown: 500,
};

/** Cost Control failures, reached when reading or topping up an Issue budget. */
const BUDGET_STATUS_BY_KIND: Record<CostControlError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'budget-out-of-range': 400,
  'budget-exhausted': 409,
  'spend-unreadable': 502,
  'already-open': 409,
  'not-open': 404,
  unauthorized: 502,
  'not-found': 404,
  'rate-limited': 429,
  server: 502,
  network: 502,
  unknown: 500,
};

/** Reads a field under either its camelCase or documented snake_case key. */
function pick(input: Record<string, unknown>, camel: string, snake: string): unknown {
  return input[camel] !== undefined ? input[camel] : input[snake];
}

/** Builds the `/api/projects/:id/issues` routes. */
export function issueRoutes(
  issues: IssuesModule,
  projects: ProjectsModule,
  plans: PlansModule,
  catalogue?: ModelCatalogue,
  budgets?: CostControlModule,
): Hono {
  const app = new Hono();

  // The literal sub-paths are registered before `/issues/:issueId` so they are
  // not captured as an issue id.
  app.get('/api/projects/:id/issues', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await issues.list(project.id);
    return result.ok
      ? c.json({ issues: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/issues/graph', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await issues.graph(project.id);
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const agentModel = parseAgentModel(input);
    if (agentModel !== undefined) {
      if (!agentModel.ok) return invalidModelField(c);
      if (agentModel.value !== null) {
        const invalid = await validateAgentModel(c, catalogue, agentModel.value);
        if (invalid !== null) return invalid;
      }
    }
    const result = await issues.create({
      projectId: project.id,
      planId: asOptionalString(pick(input, 'planId', 'plan_id')),
      title: asString(input.title),
      body: asOptionalString(input.body),
      summary: asOptionalString(input.summary),
      label: pick(input, 'label', 'label') as IssueLabel | undefined,
      dependsOn: asStringArray(pick(input, 'dependsOn', 'depends_on')),
      budgetCents: asOptionalNumber(pick(input, 'budgetCents', 'budget_cents')),
      maxAttempts: asOptionalNumber(pick(input, 'maxAttempts', 'max_attempts')),
      ...(agentModel?.ok === true && agentModel.value !== null
        ? { agentModel: agentModel.value }
        : {}),
    });
    return result.ok
      ? c.json(result.value, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues/approve', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    // Approve only the active Plan's open Issues. Approving every Issue in the
    // Project would relabel closed history and make an older Plan's leftovers
    // dispatchable the moment a new Plan is approved.
    const active = await plans.getActive(project.id);
    if (!active.ok) return fail(c, active.error, PLAN_STATUS_BY_KIND[active.error.kind]);

    const result =
      active.value === null
        ? await issues.approve(project.id)
        : await issues.approve(project.id, active.value.id);
    return result.ok
      ? c.json({ issues: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  if (budgets !== undefined) {
    app.get('/api/projects/:id/issues/:issueId/budget', async (c) => {
      const project = await projectOrResponse(c, projects, c.req.param('id'));
      if (project instanceof Response) return project;

      const issue = await issues.get(project.id, c.req.param('issueId'));
      if (!issue.ok) return fail(c, issue.error, STATUS_BY_KIND[issue.error.kind]);
      const summary = await budgets.summary(issue.value.id, issue.value.budgetCents);
      return summary.ok
        ? c.json(summary.value)
        : fail(c, summary.error, BUDGET_STATUS_BY_KIND[summary.error.kind]);
    });
  }

  app.get('/api/projects/:id/issues/:issueId', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await issues.get(project.id, c.req.param('issueId'));
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.patch('/api/projects/:id/issues/:issueId', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const patch = patchOf(input);
    const agentModel = parseAgentModel(input);
    if (agentModel !== undefined) {
      if (!agentModel.ok) return invalidModelField(c);
      if (agentModel.value !== null) {
        const invalid = await validateAgentModel(c, catalogue, agentModel.value);
        if (invalid !== null) return invalid;
      }
      patch.agentModel = agentModel.value;
    }

    // A raised budget must reach the key that is already open, not only the
    // local Issue: OpenRouter still caps that key at the old amount until the
    // next attempt mints a fresh one. An Issue without a key is not an error;
    // its next attempt reads the new budget directly.
    if (budgets !== undefined && patch.budgetCents !== undefined) {
      const existing = await issues.get(project.id, c.req.param('issueId'));
      if (!existing.ok) return fail(c, existing.error, STATUS_BY_KIND[existing.error.kind]);
      if (patch.budgetCents > existing.value.budgetCents) {
        const toppedUp = await budgets.topUp(existing.value.id, patch.budgetCents);
        if (!toppedUp.ok && toppedUp.error.kind !== 'not-open') {
          return fail(c, toppedUp.error, BUDGET_STATUS_BY_KIND[toppedUp.error.kind]);
        }
      }
    }

    const result = await issues.update(project.id, c.req.param('issueId'), patch);
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.delete('/api/projects/:id/issues/:issueId', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await issues.remove(project.id, c.req.param('issueId'));
    return result.ok
      ? c.json({ ok: true })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}

/** Reads an optional string, treating anything else as absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads an optional number, treating anything else as absent. */
function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Reads an optional list of strings, treating anything else as absent. */
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined;
}

/** Builds a partial patch from whichever fields the request body carries. */
function patchOf(input: Record<string, unknown>): IssuePatch {
  const patch: IssuePatch = {};
  if (input.title !== undefined) patch.title = asString(input.title);
  if (input.body !== undefined) patch.body = asString(input.body);
  if (input.summary !== undefined) patch.summary = asString(input.summary);
  if (input.status !== undefined) patch.status = input.status as IssueStatus;
  if (input.label !== undefined) patch.label = input.label as IssueLabel;
  const dependsOn = pick(input, 'dependsOn', 'depends_on');
  if (dependsOn !== undefined) patch.dependsOn = asStringArray(dependsOn) ?? [];
  const budgetCents = pick(input, 'budgetCents', 'budget_cents');
  if (budgetCents !== undefined) patch.budgetCents = asOptionalNumber(budgetCents);
  const maxAttempts = pick(input, 'maxAttempts', 'max_attempts');
  if (maxAttempts !== undefined) patch.maxAttempts = asOptionalNumber(maxAttempts);
  const githubNumber = pick(input, 'githubNumber', 'github_number');
  if (githubNumber !== undefined) patch.githubNumber = githubNumber as number | null;
  const closedAt = pick(input, 'closedAt', 'closed_at');
  if (closedAt !== undefined) patch.closedAt = closedAt as string | null;
  return patch;
}
