import type { ProjectError, ProjectPatch, ProjectsModule } from '@yaaabk/projects';
import type { SkillLevel } from '@yaaabk/shared';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Upstream provisioning failures (`repository`, `scaffold`, `kubernetes`) map to
 * 502: the request was valid but a dependency could not complete it.
 */
const STATUS_BY_KIND: Record<ProjectError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'duplicate-name': 409,
  'not-found': 404,
  repository: 502,
  scaffold: 502,
  kubernetes: 502,
  unknown: 500,
};

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await c.req.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads the skill level from either the camelCase or the documented snake_case key. */
function asSkillLevel(input: Record<string, unknown>): SkillLevel {
  return (input.skillLevel ?? input.skill_level) as SkillLevel;
}

function fail(c: Context, error: ProjectError) {
  return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
}

/** Builds the `/api/projects/*` routes. */
export function projectRoutes(projects: ProjectsModule): Hono {
  const app = new Hono();

  app.post('/api/projects', async (c) => {
    const input = await body(c);
    const result = await projects.create({
      name: asString(input.name),
      description: asString(input.description),
      skillLevel: asSkillLevel(input),
    });
    return result.ok ? c.json(result.value, 201) : fail(c, result.error);
  });

  app.get('/api/projects', async (c) => {
    const result = await projects.list();
    return result.ok ? c.json({ projects: result.value }) : fail(c, result.error);
  });

  app.get('/api/projects/:id', async (c) => {
    const result = await projects.get(c.req.param('id'));
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.patch('/api/projects/:id', async (c) => {
    const input = await body(c);
    const patch: ProjectPatch = {};
    if (input.description !== undefined) {
      patch.description = asString(input.description);
    }
    if (input.skillLevel !== undefined || input.skill_level !== undefined) {
      patch.skillLevel = asSkillLevel(input);
    }
    const result = await projects.update(c.req.param('id'), patch);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.delete('/api/projects/:id', async (c) => {
    const result = await projects.remove(c.req.param('id'));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  return app;
}
