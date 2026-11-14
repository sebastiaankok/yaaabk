import type { AgentError, AgentManager } from '@yaaabk/agents';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asString, body, fail, projectOrResponse } from './http';

/**
 * Agent failures map to the HTTP status the caller should act on: a malformed
 * request is a client error, an Issue without a GitHub number is a conflict, a
 * missing project or issue is a 404, and a cluster or credential failure is a
 * bad gateway.
 */
const STATUS_BY_KIND: Record<AgentError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'not-found': 404,
  'issue-not-synced': 409,
  kubernetes: 502,
  unauthorized: 401,
  unknown: 500,
};

/** Reads an optional number, treating anything else as absent. */
function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Builds the Agent routes: triggering attempts for an Issue, reading their
 * history, and the callback a running Job uses to report what it did.
 */
export function agentRoutes(agents: AgentManager, projects: ProjectsModule): Hono {
  const app = new Hono();

  app.get('/api/projects/:id/agent-runs', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await agents.projectRuns(project.id);
    return result.ok
      ? c.json({ runs: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/issues/:issueId/spawn', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const openrouterApiKey = asString(input.openrouterApiKey ?? input.openrouter_api_key);
    const result = await agents.spawn(project.id, c.req.param('issueId'), {
      ...(openrouterApiKey === '' ? {} : { openrouterApiKey }),
    });
    return result.ok
      ? c.json(result.value, 202)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/issues/:issueId/runs', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await agents.runs(project.id, c.req.param('issueId'));
    return result.ok
      ? c.json({ runs: result.value })
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  /**
   * The callback an Agent Job makes when it finishes. It is not behind the
   * session guard; the Job authenticates with the per-run token instead.
   */
  app.post('/api/agent-runs/:runId/report', async (c) => {
    const input = await body(c);
    const token = asString(input.token);
    const result = await agents.report(c.req.param('runId'), token, {
      prUrl: typeof input.prUrl === 'string' ? input.prUrl : undefined,
      costCents: asOptionalNumber(input.costCents ?? input.cost_cents),
      logs: typeof input.logs === 'string' ? input.logs : undefined,
    });
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}
