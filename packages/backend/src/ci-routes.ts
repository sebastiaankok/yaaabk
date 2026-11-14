import type { CiTracker, CiTrackerError } from '@yaaabk/ci-tracker';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { body, fail } from './http';

/**
 * CI Tracker failures map to the HTTP status the caller should act on: a
 * malformed configuration is a client error and anything else is a server
 * error.
 */
function statusFor(error: CiTrackerError): ContentfulStatusCode {
  return error.kind === 'invalid-input' ? 400 : 500;
}

/** Reads an interval from either the camelCase or the documented snake_case key. */
function asInterval(input: Record<string, unknown>): number | undefined {
  const value = input.intervalMs ?? input.interval_ms;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Builds the admin routes for the CI Tracker: its current status and the
 * configuration of the background polling loop.
 */
export function ciRoutes(ci: CiTracker): Hono {
  const app = new Hono();

  app.get('/api/admin/ci/status', (c) => c.json(ci.status()));

  app.patch('/api/admin/ci/config', async (c) => {
    const input = await body(c);
    const intervalMs = asInterval(input);
    const result = ci.configure({
      ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });
    return result.ok ? c.json(result.value) : fail(c, result.error, statusFor(result.error));
  });

  return app;
}
