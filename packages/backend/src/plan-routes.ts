import type { IssueSyncModule } from '@yaaabk/github';
import type { IssuesModule } from '@yaaabk/issues';
import type { PlanError, PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asSkillLevel, asSource, asString, body, fail, projectOrResponse } from './http';

/**
 * Plan failures map to the HTTP status the caller should act on: a malformed
 * version is a client error, a duplicate version or a blocked acceptance is a
 * conflict, a missing project or plan is a 404, and a failed GitHub push is a
 * bad gateway.
 */
const STATUS_BY_KIND: Record<PlanError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'duplicate-version': 409,
  'not-found': 404,
  'not-acceptable': 409,
  'sync-failed': 502,
  unknown: 500,
};

/** Builds the `/api/projects/:id/plans` routes. */
export function planRoutes(
  projects: ProjectsModule,
  plans: PlansModule,
  issues: IssuesModule,
  issueSync: IssueSyncModule,
): Hono {
  const app = new Hono();

  app.post('/api/projects/:id/plans', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const result = await plans.create({
      projectId: project.id,
      contentMarkdown: asString(input.content_markdown ?? input.contentMarkdown),
      ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
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

  app.post('/api/projects/:id/plans/:planId/accept', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const planId = c.req.param('planId');
    const [listed, graphed] = await Promise.all([
      issues.list(project.id),
      issues.graph(project.id),
    ]);
    if (!listed.ok) return fail(c, listed.error, 500);
    if (!graphed.ok) return fail(c, graphed.error, 500);

    // Acceptance checks the Plan's own Issues: a cycle or a missing dependency
    // in another version must not block this one, and vice versa.
    const nodeById = new Map(graphed.value.nodes.map((node) => [node.id, node]));
    const planIssues = listed.value.filter((issue) => issue.planId === planId);

    const result = await plans.accept(project.id, planId, {
      facts: {
        issueCount: planIssues.length,
        issues: planIssues.map((issue) => {
          const node = nodeById.get(issue.id);
          return {
            title: issue.title,
            wave: node?.wave ?? null,
            missing: node?.missing ?? [],
          };
        }),
      },
      async push() {
        const pushed = await issueSync.push(project.id, project.repoFullName, { planId });
        return pushed.ok ? { ok: true } : { ok: false, message: pushed.error.message };
      },
    });
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}
