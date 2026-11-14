import type { GrillMeError, GrillMeModule } from '@yaaabk/grill-me';
import type { IssueError, IssueLabel, IssuePatch, IssueStatus, IssuesModule } from '@yaaabk/issues';
import type { PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asString, body, fail, projectOrResponse } from './http';

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

/** Grill-me failures map the same way its own routes do. */
const GRILL_STATUS_BY_KIND: Record<GrillMeError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'unknown-session': 404,
  'spawn-failed': 502,
  'write-failed': 502,
  timeout: 504,
  'invalid-issues': 422,
  'process-failed': 502,
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
  grillMe: GrillMeModule,
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
    const result = await issues.create({
      projectId: project.id,
      planId: asOptionalString(pick(input, 'planId', 'plan_id')),
      title: asString(input.title),
      body: asOptionalString(input.body),
      label: pick(input, 'label', 'label') as IssueLabel | undefined,
      dependsOn: asStringArray(pick(input, 'dependsOn', 'depends_on')),
      budgetCents: asOptionalNumber(pick(input, 'budgetCents', 'budget_cents')),
      maxAttempts: asOptionalNumber(pick(input, 'maxAttempts', 'max_attempts')),
    });
    return result.ok
      ? c.json(result.value, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues/generate', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const active = await plans.getActive(project.id);
    if (!active.ok) {
      return fail(c, active.error, 500);
    }
    if (active.value === null) {
      return c.json({ error: 'not-found', message: 'No active plan' }, 404);
    }

    const generated = await grillMe.generateIssues(
      project.id,
      active.value.contentMarkdown,
      project.skillLevel,
    );
    if (!generated.ok) {
      return fail(c, generated.error, GRILL_STATUS_BY_KIND[generated.error.kind]);
    }

    const result = await issues.replaceForPlan(project.id, active.value.id, generated.value);
    return result.ok
      ? c.json({ issues: result.value }, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues/refine', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const feedback = asString(input.feedback);
    if (feedback.trim() === '') {
      return c.json({ error: 'invalid-input', message: 'Refinement feedback is required' }, 400);
    }

    const active = await plans.getActive(project.id);
    if (!active.ok) {
      return fail(c, active.error, 500);
    }
    if (active.value === null) {
      return c.json({ error: 'not-found', message: 'No active plan' }, 404);
    }

    const generated = await grillMe.generateIssues(
      project.id,
      active.value.contentMarkdown,
      project.skillLevel,
      { feedback },
    );
    if (!generated.ok) {
      return fail(c, generated.error, GRILL_STATUS_BY_KIND[generated.error.kind]);
    }

    const result = await issues.replaceForPlan(project.id, active.value.id, generated.value);
    return result.ok
      ? c.json({ issues: result.value }, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues/approve', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await issues.approve(project.id);
    return result.ok
      ? c.json({ issues: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

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
    const result = await issues.update(project.id, c.req.param('issueId'), patchOf(input));
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
