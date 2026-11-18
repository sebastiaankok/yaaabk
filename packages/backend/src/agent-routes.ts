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

/** Reads a deploy outcome, treating anything else as absent. */
function asDeployOutcome(value: unknown): 'success' | 'failed' | undefined {
  return value === 'success' || value === 'failed' ? value : undefined;
}

/** One SSE frame: an event name and a JSON payload. */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Proxies a run's log stream to the browser as SSE: one `log` frame per chunk,
 * then `end`. A chunk may split mid-line, so the client appends frames as they
 * arrive rather than treating them as complete lines.
 */
function logStream(source: ReadableStream<Uint8Array>): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stopReading: (() => Promise<void>) | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      stopReading = () =>
        reader.cancel().then(
          () => undefined,
          () => undefined,
        );
      const emit = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk !== '') emit('log', { chunk });
        }
        if (!closed) {
          closed = true;
          emit('end', {});
          controller.close();
        }
      } catch (cause) {
        if (closed) return;
        closed = true;
        try {
          emit('error', { message: cause instanceof Error ? cause.message : String(cause) });
          controller.close();
        } catch {
          // The browser closed the page; nothing left to tell it.
        }
      }
    },
    async cancel() {
      // The browser went away: stop reading the Pod log instead of holding the
      // kubectl stream open for the rest of the attempt.
      closed = true;
      await stopReading?.();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
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
   * Streams a run's output to the browser while the attempt is still running.
   *
   * Kept under `/api/projects/...` rather than `/api/agent-runs/...`: the
   * latter is exempt from session auth because Jobs call it with their per-run
   * token, and this route must not inherit that exemption.
   */
  app.get('/api/projects/:id/agent-runs/:runId/logs', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const runId = c.req.param('runId');
    const runs = await agents.projectRuns(project.id);
    if (!runs.ok) return fail(c, runs.error, STATUS_BY_KIND[runs.error.kind]);
    const run = runs.value.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      return c.json({ error: 'not-found', message: `No agent run with id "${runId}"` }, 404);
    }

    const result = await agents.logs(runId, { follow: run.status === 'running' });
    return result.ok
      ? logStream(result.value)
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
      commitSha: typeof input.commitSha === 'string' ? input.commitSha : undefined,
      deployOutcome: asDeployOutcome(input.deployOutcome ?? input.deploy_outcome),
    });
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  return app;
}
