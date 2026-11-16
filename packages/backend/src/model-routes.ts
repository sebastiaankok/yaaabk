import type { ModelCatalogue } from '@yaaabk/cost-control';
import { Hono } from 'hono';

/**
 * Builds the `/api/models` route: the live OpenRouter catalogue filtered to
 * tool-capable models, plus the environment default the Plan page preselects
 * when a Project has no last-used model.
 */
export function modelRoutes(catalogue: ModelCatalogue, defaultModel: string): Hono {
  const app = new Hono();

  app.get('/api/models', async (c) => {
    const result = await catalogue.list();
    if (!result.ok) {
      return c.json({ error: result.error.kind, message: result.error.message }, 502);
    }
    return c.json({ models: result.value, defaultModel });
  });

  return app;
}
