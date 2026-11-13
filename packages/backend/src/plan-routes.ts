import type { PlanError, PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asSkillLevel, asSource, asString, body, fail, projectOrResponse } from './http';

/**
 * Plan failures map to the HTTP status the caller should act on: a malformed
 * version is a client error, a duplicate version is a conflict, and a missing
 * project or plan is a 404.
 */
const STATUS_BY_KIND: Record<PlanError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'duplicate-version': 409,
  'not-found': 404,
  unknown: 500,
};

/** Builds the `/api/projects/:id/plans` routes. */
export function planRoutes(projects: ProjectsModule, plans: PlansModule): Hono {
  const app = new Hono();

  app.post('/api/projects/:id/plans', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const result = await plans.create({
      projectId: project.id,
      contentMarkdown: asString(input.content_markdown ?? input.contentMarkdown),
      skillLevel: asSkillLevel(input) ?? project.skillLevel,
      source: asSource(input),
    });
    return result.ok
      ? c.json(result.value, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/plans', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await plans.list(project.id);
    return result.ok
      ? c.json({ plans: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/plans/active', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await plans.getActive(project.id);
    if (!result.ok) {
      return fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
    }
    if (result.value === null) {
      return c.json({ error: 'not-found', message: 'No active plan' }, 404);
    }
    return c.json(result.value);
  });

  app.post('/api/projects/:id/plans/:planId/activate', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await plans.activate(project.id, c.req.param('planId'));
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}
