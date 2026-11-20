import type { ModelCatalogue } from '@yaaabk/cost-control';
import type {
  ExportProjectInput,
  ProjectError,
  ProjectPatch,
  ProjectsModule,
  ProvisioningEvent,
} from '@yaaabk/projects';
import type { ProjectMode } from '@yaaabk/shared';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { invalidModelField, parseAgentModel, validateAgentModel } from './model-validation';

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

/** Reads the project mode from the request body. */
function asMode(input: Record<string, unknown>): ProjectMode {
  return input.mode as ProjectMode;
}

function fail(c: Context, error: ProjectError) {
  return c.json({ error: error.kind, message: error.message }, STATUS_BY_KIND[error.kind]);
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
 * Runs `create` and streams each provisioning step as it happens: an SSE
 * `progress` frame per step lifecycle event, then one final frame — `done`
 * carrying the created Project, or `error` carrying the failure. The response
 * is committed to 200 before provisioning starts, so every outcome travels in
 * the stream rather than as an HTTP status.
 */
function streamCreate(
  projects: ProjectsModule,
  input: { name: string; description: string; mode: ProjectMode },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };
      try {
        const result = await projects.create(input, {
          onProgress: (event: ProvisioningEvent) => emit('progress', event),
        });
        if (result.ok) {
          emit('done', result.value);
        } else {
          emit('error', { error: { kind: result.error.kind, message: result.error.message } });
        }
      } catch (cause) {
        emit('error', { error: { kind: 'unknown', message: String(cause) } });
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/** Builds the `/api/projects/*` routes. */
export function projectRoutes(projects: ProjectsModule, catalogue?: ModelCatalogue): Hono {
  const app = new Hono();

  app.post('/api/projects', async (c) => {
    const input = await body(c);
    const createInput = {
      name: asString(input.name),
      description: asString(input.description),
      mode: asMode(input),
    };
    if ((c.req.header('accept') ?? '').includes('text/event-stream')) {
      return streamCreate(projects, createInput);
    }
    const result = await projects.create(createInput);
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
    if (input.mode !== undefined) {
      patch.mode = asMode(input);
    }
    const agentModel = parseAgentModel(input);
    if (agentModel !== undefined) {
      if (!agentModel.ok) return invalidModelField(c);
      if (agentModel.value !== null) {
        const invalid = await validateAgentModel(c, catalogue, agentModel.value);
        if (invalid !== null) return invalid;
      }
      patch.agentModel = agentModel.value;
    }
    const result = await projects.update(c.req.param('id'), patch);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  app.delete('/api/projects/:id', async (c) => {
    const result = await projects.remove(c.req.param('id'));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error);
  });

  app.post('/api/projects/:id/export', async (c) => {
    const input = await body(c);
    const exportInput: ExportProjectInput = { owner: asString(input.owner) };
    if (input.repoName !== undefined) {
      exportInput.repoName = asString(input.repoName);
    }
    const result = await projects.export(c.req.param('id'), exportInput);
    return result.ok ? c.json(result.value) : fail(c, result.error);
  });

  return app;
}
