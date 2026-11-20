import type { AgentManager } from '@yaaabk/agents';
import type { IssuesModule } from '@yaaabk/issues';
import type { PlansModule } from '@yaaabk/plans';
import type { Project, ProjectsModule } from '@yaaabk/projects';
import { composeProjectOverview, type ProjectOverview } from '@yaaabk/stats';
import { type Context, Hono } from 'hono';
import { fail, projectOrResponse } from './http';

/**
 * Builds the overview read model for one Project: its Project row, active Plan,
 * Issues and Agent runs, composed into one response the home list and project
 * page can render without extra requests.
 */
async function composeOverview(
  c: Context,
  project: Project,
  plans: PlansModule,
  issues: IssuesModule,
  agents: AgentManager,
): Promise<ProjectOverview | Response> {
  const activePlan = await plans.getActive(project.id);
  if (!activePlan.ok) return fail(c, activePlan.error, 500);

  const issueList = await issues.list(project.id);
  if (!issueList.ok) return fail(c, issueList.error, 500);

  const runList = await agents.projectRuns(project.id);
  if (!runList.ok) return fail(c, runList.error, 500);

  return composeProjectOverview(project, activePlan.value, issueList.value, runList.value);
}

/** Builds the `/api/overview` and `/api/projects/:id/overview` routes. */
export function overviewRoutes(
  projects: ProjectsModule,
  plans: PlansModule,
  issues: IssuesModule,
  agents: AgentManager,
): Hono {
  const app = new Hono();

  app.get('/api/overview', async (c) => {
    const list = await projects.list();
    if (!list.ok) return fail(c, list.error, 500);

    const overviews: ProjectOverview[] = [];
    for (const project of list.value) {
      const overview = await composeOverview(c, project, plans, issues, agents);
      if (overview instanceof Response) return overview;
      overviews.push(overview);
    }
    return c.json({ overviews });
  });

  app.get('/api/projects/:id/overview', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const overview = await composeOverview(c, project, plans, issues, agents);
    return overview instanceof Response ? overview : c.json(overview);
  });

  return app;
}
