import {
  createTerminalBridge,
  type BrowserTerminalMessage,
  type GrillSessionError,
  type GrillSessionsModule,
  type SessionTerminalEndpoint,
  type TerminalBridge,
  type TerminalServerMessage,
} from '@yaaabk/grill-me';
import type { PlansModule } from '@yaaabk/plans';
import type { ProjectsModule } from '@yaaabk/projects';
import { Hono } from 'hono';
import type { UpgradeWebSocket, WSContext } from 'hono/ws';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asString, body, fail, projectOrResponse } from './http';

/** A session failure maps to the status the caller should act on. */
const STATUS_BY_KIND: Record<GrillSessionError['kind'], ContentfulStatusCode> = {
  'invalid-input': 400,
  'not-found': 404,
  'start-failed': 502,
  unknown: 500,
};

export interface GrillRoutesOptions {
  /**
   * Bun's WebSocket upgrader. Omitted in unit tests, where upgrade attempts
   * return 501 instead of reaching a server.
   */
  upgradeWebSocket?: UpgradeWebSocket;
  /** Test seam for the upstream ttyd bridge. */
  terminalBridgeFactory?: typeof createTerminalBridge;
}

function send(ws: WSContext, message: TerminalServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function parseBrowserMessage(raw: unknown): BrowserTerminalMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['type'] === 'input' && typeof value['data'] === 'string') {
      return { type: 'input', data: value['data'] };
    }
    if (
      value['type'] === 'resize' &&
      typeof value['columns'] === 'number' &&
      typeof value['rows'] === 'number' &&
      value['columns'] > 0 &&
      value['rows'] > 0
    ) {
      return { type: 'resize', columns: value['columns'], rows: value['rows'] };
    }
    return null;
  } catch {
    return null;
  }
}

/** One upstream ttyd connection, kept alive across browser refreshes. */
interface TerminalConnection {
  bridge: TerminalBridge;
  browser: WSContext | null;
  ready: boolean;
}

/** Builds the `/api/projects/:id/grill` session and terminal routes. */
export function grillRoutes(
  sessions: GrillSessionsModule,
  projects: ProjectsModule,
  plans: PlansModule,
  options: GrillRoutesOptions = {},
): Hono {
  const app = new Hono();
  const terminals = new Map<string, TerminalConnection>();

  function closeTerminal(sessionId: string): void {
    const entry = terminals.get(sessionId);
    if (entry === undefined) return;
    terminals.delete(sessionId);
    entry.browser?.close(1000, 'session ended');
    entry.bridge.close();
  }

  function openTerminal(sessionId: string, endpoint: SessionTerminalEndpoint): TerminalConnection {
    const factory = options.terminalBridgeFactory ?? createTerminalBridge;
    const entry: TerminalConnection = {
      bridge: undefined as unknown as TerminalBridge,
      browser: null,
      ready: false,
    };
    entry.bridge = factory({
      endpoint,
      onOutput(data) {
        void sessions.touch(sessionId);
        const browser = entry.browser;
        if (browser !== null) send(browser, { type: 'output', data });
      },
      onTitle(data) {
        const browser = entry.browser;
        if (browser !== null) send(browser, { type: 'title', data });
      },
      onPreferences(data) {
        const browser = entry.browser;
        if (browser !== null) send(browser, { type: 'preferences', data });
      },
      onReady() {
        entry.ready = true;
        const browser = entry.browser;
        if (browser !== null) send(browser, { type: 'status', status: 'live' });
      },
      onError(reason) {
        const browser = entry.browser;
        if (browser !== null) send(browser, { type: 'status', status: 'closed', reason });
      },
      onClose(reason) {
        terminals.delete(sessionId);
        const browser = entry.browser;
        if (browser !== null) {
          send(browser, { type: 'status', status: 'closed', reason });
          browser.close(1000, reason.slice(0, 120));
        }
      },
    });
    terminals.set(sessionId, entry);
    return entry;
  }

  app.post('/api/projects/:id/grill', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const input = await body(c);
    const active = await plans.getActive(project.id);
    if (!active.ok) {
      return fail(c, active.error, 500);
    }

    const model = asString(input.model);
    const result = await sessions.start({
      projectId: project.id,
      projectName: project.name,
      idea: asString(input.idea ?? input.message),
      skillLevel: project.skillLevel,
      model: model.trim() === '' ? null : model,
      activePlan: active.value?.contentMarkdown ?? null,
      repoFullName: project.repoFullName,
    });
    return result.ok
      ? c.json(result.value, 201)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/grill', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sessions.getActive(project.id);
    if (!result.ok) {
      return fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
    }
    return result.value === null
      ? c.json({ error: 'not-found', message: 'No active grill session' }, 404)
      : c.json(result.value);
  });

  app.get('/api/projects/:id/grill/:sessionId', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const result = await sessions.get(project.id, c.req.param('sessionId'));
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.post('/api/projects/:id/grill/:sessionId/cancel', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const sessionId = c.req.param('sessionId');
    const result = await sessions.cancel(project.id, sessionId);
    if (result.ok) closeTerminal(sessionId);
    return result.ok
      ? c.json(result.value)
      : fail(c, result.error, STATUS_BY_KIND[result.error.kind]);
  });

  app.get('/api/projects/:id/grill/:sessionId/terminal', async (c) => {
    const project = await projectOrResponse(c, projects, c.req.param('id'));
    if (project instanceof Response) return project;

    const sessionId = c.req.param('sessionId');
    const current = await sessions.get(project.id, sessionId);
    if (!current.ok) {
      return fail(c, current.error, STATUS_BY_KIND[current.error.kind]);
    }
    if (current.value.status !== 'active') {
      return c.json({ error: 'not-found', message: `Grill session "${sessionId}" has ended` }, 404);
    }

    const terminal = await sessions.terminal(sessionId);
    if (!terminal.ok) {
      return fail(c, terminal.error, STATUS_BY_KIND[terminal.error.kind]);
    }

    const upgrade = options.upgradeWebSocket;
    if (upgrade === undefined) {
      return c.json(
        { error: 'unsupported', message: 'This server does not expose a WebSocket terminal' },
        501,
      );
    }

    return upgrade(c, {
      onOpen(_event, ws) {
        try {
          const entry = terminals.get(sessionId) ?? openTerminal(sessionId, terminal.value);
          entry.browser = ws;
          send(ws, {
            type: 'status',
            status: entry.ready ? 'live' : 'connecting',
          });
        } catch {
          send(ws, {
            type: 'status',
            status: 'closed',
            reason: 'Could not connect to the session terminal',
          });
          ws.close(1011, 'terminal unavailable');
        }
      },
      onMessage(event, ws) {
        const entry = terminals.get(sessionId);
        if (entry === undefined || entry.browser !== ws) return;
        const message = parseBrowserMessage(event.data);
        if (message === null) return;
        void sessions.touch(sessionId);
        if (message.type === 'input') entry.bridge.input(message.data);
        else entry.bridge.resize({ columns: message.columns, rows: message.rows });
      },
      onClose(_event, ws) {
        // Keep the upstream ttyd connection (and OpenCode) alive so a page
        // refresh reconnects to the same session. Finish, Cancel or a runtime
        // failure closes it.
        const entry = terminals.get(sessionId);
        if (entry?.browser === ws) entry.browser = null;
      },
    });
  });

  return app;
}
