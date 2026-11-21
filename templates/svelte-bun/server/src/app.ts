import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';

/** Absolute path to the SvelteKit build, independent of the working directory. */
const webRoot = join(import.meta.dir, '..', '..', 'web', 'build');
const indexPath = join(webRoot, 'index.html');

/**
 * The {{projectName}} API.
 *
 * JSON endpoints live under `/api/*`; everything else is served from the
 * SvelteKit build in `web/build`.
 */
export const app = new Hono();

app.use('/api/*', cors());

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/hello', (c) => c.json({ message: 'Hello from {{projectName}}' }));

// Serve the built SvelteKit single-page app, falling back to `index.html` so
// client-side routes resolve. Unknown API routes must stay JSON 404s: without
// the guard, the fallback would answer them with `index.html` and a 200.
app.use('*', serveStatic({ root: webRoot }));
app.get('*', async (c) => {
  const path = c.req.path;
  if (path === '/api' || path.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.html(await readFile(indexPath, 'utf8'));
});
