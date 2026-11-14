import type { IssueSyncError, IssueSyncModule } from '@yaaabk/github';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { fail, projectOrResponse } from './http';

/**
 * Sync failures map to the HTTP status the caller should act on: a malformed
 * request is a client error, a missing Project is a 404, an exhausted rate limit
 * is a 429, and any other GitHub failure is a bad gateway.
 */
function statusFor(error: IssueSyncError): ContentfulStatusCode {
  switch (error.kind) {
    case 'invalid-input':
      return 400;
    case 'not-found':
      return 404;
    case 'github':
      return error.github?.kind === 'rate-limited' ? 429 : 502;
    default:
      return 500;
  }
}

/** Builds the `/api/projects/:id/issues/sync` routes. */
export function issueSyncRoutes(sync: IssueSyncModule, projects: ProjectsModule): Hono {
  const app = new Hono();

  app.get('/api/projects/:id/issues/sync/status', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sync.status(project.id);
    return result.ok ? c.json(result.value) : fail(c, result.error, statusFor(result.error));
  });

  app.post('/api/projects/:id/issues/sync/push', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sync.push(project.id, project.repoFullName);
    return result.ok ? c.json(result.value) : fail(c, result.error, statusFor(result.error));
  });

  app.post('/api/projects/:id/issues/sync/pull', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sync.pull(project.id, project.repoFullName);
    return result.ok ? c.json(result.value) : fail(c, result.error, statusFor(result.error));
  });

  app.post('/api/projects/:id/issues/sync', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sync.sync(project.id, project.repoFullName);
    return result.ok ? c.json(result.value) : fail(c, result.error, statusFor(result.error));
  });

  return app;
}
