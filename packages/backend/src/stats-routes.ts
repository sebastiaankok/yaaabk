import type { AgentManager } from '@yaaabk/agents';
import type { IssuesModule } from '@yaaabk/issues';
import type { ProjectsModule } from '@yaaabk/projects';
import { computeProjectStats } from '@yaaabk/stats';
import { type Context, Hono } from 'hono';
import { fail, projectOrResponse } from './http';

/** Reads an optional ISO-8601 query parameter, or `undefined` when absent/blank. */
function parseDate(c: Context, name: string): Date | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Builds the `GET /api/projects/:id/stats` route. */
export function statsRoutes(
  issues: IssuesModule,
  agents: AgentManager,
  projects: ProjectsModule,
  clock: () => Date = () => new Date(),
): Hono {
  const app = new Hono();

  app.get('/api/projects/:id/stats', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const from = parseDate(c, 'from');
    const to = parseDate(c, 'to');
    if (
      c.req.query('from') !== undefined &&
      c.req.query('from')?.trim() !== '' &&
      from === undefined
    ) {
      return c.json({ error: 'invalid-input', message: '`from` must be an ISO-8601 date' }, 400);
    }
    if (c.req.query('to') !== undefined && c.req.query('to')?.trim() !== '' && to === undefined) {
      return c.json({ error: 'invalid-input', message: '`to` must be an ISO-8601 date' }, 400);
    }

    const issueList = await issues.list(project.id);
    if (!issueList.ok) return fail(c, issueList.error, 500);

    const runList = await agents.projectRuns(project.id);
    if (!runList.ok) return fail(c, runList.error, 500);

    try {
      return c.json(
        computeProjectStats(issueList.value, runList.value, {
          now: clock(),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: 'invalid-input', message: error.message }, 400);
      }
      throw error;
    }
  });

  return app;
}
