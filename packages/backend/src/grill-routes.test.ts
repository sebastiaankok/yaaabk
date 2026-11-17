import { describe, expect, it } from 'vitest';
import type { TerminalBridge, TerminalBridgeOptions, TerminalSize } from '@yaaabk/grill-me';
import type { UpgradeWebSocket, WSEvents, WSContext } from 'hono/ws';
import { SESSION_COOKIE } from './auth-routes';
import { createTestContext, signIn, type TestContext } from './test-support';

const PROJECT = { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' } as const;

async function request(
  context: TestContext,
  session: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return context.app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${session}`,
      ...init.headers,
    },
  });
}

async function signedIn(): Promise<{ context: TestContext; session: string }> {
  const context = createTestContext();
  const session = await signIn(context);
  return { context, session };
}

async function createProject(context: TestContext, name = 'todo-app'): Promise<string> {
  const created = await context.projects.create({ ...PROJECT, name });
  if (!created.ok) throw new Error('create failed');
  return created.value.id;
}

interface SessionBody {
  id: string;
  projectId: string;
  status: string;
  model: string;
  terminalPath: string;
}

async function startSession(
  context: TestContext,
  session: string,
  projectId: string,
  payload: Record<string, unknown> = { idea: 'A todo app' },
): Promise<SessionBody> {
  const res = await request(context, session, `/api/projects/${projectId}/grill`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as SessionBody;
}

interface FakeTerminalBridge {
  factory(options: TerminalBridgeOptions): TerminalBridge;
  bridge: TerminalBridge;
  readonly created: number;
  readonly options: TerminalBridgeOptions;
  readonly input: string[];
  readonly resize: TerminalSize[];
  readonly closed: boolean;
}

function fakeTerminalBridge(): FakeTerminalBridge {
  const input: string[] = [];
  const resize: TerminalSize[] = [];
  let created = 0;
  let closed = false;
  let options: TerminalBridgeOptions | undefined;
  const bridge: TerminalBridge = {
    input(data) {
      input.push(data);
    },
    resize(size) {
      resize.push(size);
    },
    close() {
      closed = true;
    },
  };
  return {
    factory(next) {
      created += 1;
      options = next;
      return bridge;
    },
    bridge,
    get created() {
      return created;
    },
    get options() {
      if (options === undefined) throw new Error('no bridge created');
      return options;
    },
    get input() {
      return input;
    },
    get resize() {
      return resize;
    },
    get closed() {
      return closed;
    },
  };
}

interface FakeWebSocket {
  ws: WSContext;
  readonly messages: Array<Record<string, unknown>>;
  readonly closed: { code?: number; reason?: string } | undefined;
}

function fakeWebSocket(): FakeWebSocket {
  const messages: Array<Record<string, unknown>> = [];
  let closed: { code?: number; reason?: string } | undefined;
  const ws = {
    readyState: 1,
    send(data: string) {
      messages.push(JSON.parse(data) as Record<string, unknown>);
    },
    close(code?: number, reason?: string) {
      closed = {
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      };
    },
  } as unknown as WSContext;
  return {
    ws,
    messages,
    get closed() {
      return closed;
    },
  };
}

describe('POST /api/projects/:id/grill', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/projects/missing/grill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(401);
  });

  it('starts a terminal session for the project', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const started = await startSession(context, session, projectId, { idea: 'A todo app' });

    expect(started.id).toMatch(/^grill-/);
    expect(started.projectId).toBe(projectId);
    expect(started.status).toBe('active');
    expect(started.model).toBe('openrouter/default-model');
    expect(started.terminalPath).toContain(`/grill/${started.id}/terminal`);
    expect(JSON.stringify(started)).not.toContain('test-token');

    const runtimeRequest = context.sessionRuntime.requests[0];
    expect(runtimeRequest).toMatchObject({
      projectId,
      idea: 'A todo app',
      skillLevel: 'expert',
      model: 'openrouter/default-model',
      namespace: expect.stringMatching(/^yaaabk-/),
      repoFullName: expect.stringContaining('/'),
    });
    expect(runtimeRequest?.prompt).toContain('A todo app');
  });

  it('uses a requested model and carries the active plan into the prompt', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    await context.plans.create({
      projectId,
      contentMarkdown: '# Existing plan',
      skillLevel: 'expert',
      source: 'grill-me',
    });

    const started = await startSession(context, session, projectId, {
      idea: 'Add tags',
      model: 'openrouter/chosen',
    });

    expect(started.model).toBe('openrouter/chosen');
    expect(context.sessionRuntime.requests[0]?.prompt).toContain('# Existing plan');
  });

  it('rejects a model outside the tool-capable catalogue', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill`, {
      method: 'POST',
      body: JSON.stringify({ idea: 'A todo app', model: 'openrouter/not-a-model' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid-model',
      message: expect.stringContaining('openrouter/not-a-model'),
    });
    expect(context.sessionRuntime.requests).toHaveLength(0);
  });

  it('remembers the model the Project last used and reuses it when omitted', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    await startSession(context, session, projectId, {
      idea: 'A todo app',
      model: 'openrouter/chosen',
    });
    const reused = await startSession(context, session, projectId, { idea: 'Another idea' });

    expect(reused.model).toBe('openrouter/chosen');
    const project = await context.projects.get(projectId);
    expect(project.ok && project.value.lastModel).toBe('openrouter/chosen');
  });

  it('fails start with the message naming the missing platform credential', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    context.sessionKeys.failNext(
      'OpenRouter is not configured: add a management key in Settings to start a session.',
    );

    const res = await request(context, session, `/api/projects/${projectId}/grill`, {
      method: 'POST',
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: 'start-failed',
      message: expect.stringContaining('management key in Settings'),
    });
    expect(context.sessionRuntime.requests).toHaveLength(0);
  });

  it('returns 404 for an unknown project', async () => {
    const { context, session } = await signedIn();

    const res = await request(context, session, '/api/projects/missing/grill', {
      method: 'POST',
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects an empty idea with 400', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill`, {
      method: 'POST',
      body: JSON.stringify({ idea: '   ' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('returns the runtime failure reason as a bad gateway', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    context.sessionRuntime.failNextStart('ttyd: exec format error');

    const res = await request(context, session, `/api/projects/${projectId}/grill`, {
      method: 'POST',
      body: JSON.stringify({ idea: 'A todo app' }),
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: 'start-failed',
      message: expect.stringContaining('exec format error'),
    });
  });

  it('stops and replaces the previous session for the same project', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const first = await startSession(context, session, projectId, { idea: 'First' });
    const second = await startSession(context, session, projectId, { idea: 'Second' });

    expect(context.sessionRuntime.stopped.map((ref) => ref.sessionId)).toEqual([first.id]);

    const previous = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${first.id}`,
    );
    expect(previous.status).toBe(200);
    await expect(previous.json()).resolves.toMatchObject({
      status: 'cancelled',
      endReason: 'replaced',
    });

    const active = await request(context, session, `/api/projects/${projectId}/grill`);
    await expect(active.json()).resolves.toMatchObject({ id: second.id });
  });
});

describe('GET /api/projects/:id/grill', () => {
  it('returns the active session so a refresh can reconnect', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    const res = await request(context, session, `/api/projects/${projectId}/grill`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: started.id,
      status: 'active',
    });
  });

  it('returns 404 when no session is live', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);

    const res = await request(context, session, `/api/projects/${projectId}/grill`);

    expect(res.status).toBe(404);
  });

  it('returns a cancelled session with the reason it ended', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await request(context, session, `/api/projects/${projectId}/grill/${started.id}/cancel`, {
      method: 'POST',
    });

    const res = await request(context, session, `/api/projects/${projectId}/grill/${started.id}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: started.id,
      status: 'cancelled',
      endReason: 'cancelled',
    });
  });

  it('returns a timed-out session after the idle sweep', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    context.clock.ms += 30 * 60_000;
    await context.grillSessions.sweep();

    const res = await request(context, session, `/api/projects/${projectId}/grill/${started.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      endReason: string;
      error: string;
    };
    expect(body).toMatchObject({
      id: started.id,
      status: 'failed',
      endReason: 'timeout',
    });
    expect(body.error).toContain('30 minutes without terminal activity');
  });

  it('returns 404 for a session that belongs to another project', async () => {
    const { context, session } = await signedIn();
    const first = await createProject(context, 'todo-app');
    const second = await createProject(context, 'other-app');
    const started = await startSession(context, session, first);

    const res = await request(context, session, `/api/projects/${second}/grill/${started.id}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/grill/:sessionId/cancel', () => {
  it('stops the runtime and ends the session', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/cancel`,
      { method: 'POST' },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'cancelled',
      endReason: 'cancelled',
    });
    expect(context.sessionRuntime.stopped.map((ref) => ref.sessionId)).toEqual([started.id]);

    const active = await request(context, session, `/api/projects/${projectId}/grill`);
    expect(active.status).toBe(404);
  });

  it('returns 404 when cancelling twice', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await request(context, session, `/api/projects/${projectId}/grill/${started.id}/cancel`, {
      method: 'POST',
    });

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/cancel`,
      { method: 'POST' },
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /api/grill-sessions/:sessionId/report', () => {
  function bearer(token: string | undefined): Record<string, string> {
    return token === undefined ? {} : { authorization: `Bearer ${token}` };
  }

  it('needs no Developer cookie but rejects a missing or wrong token', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    const without = await context.app.request(`/api/grill-sessions/${started.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prd: '# PRD' }),
    });
    const wrong = await context.app.request(`/api/grill-sessions/${started.id}/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...bearer('not-the-token'),
      },
      body: JSON.stringify({ prd: '# PRD' }),
    });

    expect(without.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('stores a draft without creating Plan or Issue records', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    const token = context.sessionRuntime.requests.at(-1)?.reportToken ?? '';

    const reported = await context.app.request(`/api/grill-sessions/${started.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({ prd: '# PRD' }),
    });

    expect(reported.status).toBe(200);
    await expect(reported.json()).resolves.toMatchObject({
      draft: { hasPrd: true, issueCount: 0 },
    });
    const storedPlans = await context.plans.list(projectId);
    expect(storedPlans.ok && storedPlans.value).toHaveLength(0);
    const storedIssues = await context.issues.list(projectId);
    expect(storedIssues.ok && storedIssues.value).toHaveLength(0);
  });

  it('rejects Issues reported without a PRD draft', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    const token = context.sessionRuntime.requests.at(-1)?.reportToken ?? '';

    const res = await context.app.request(`/api/grill-sessions/${started.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({ issues: [{ title: 'Save a bookmark' }] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-input' });
  });

  it('returns the session status to the same bearer token', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    const token = context.sessionRuntime.requests.at(-1)?.reportToken ?? '';

    const res = await context.app.request(`/api/grill-sessions/${started.id}/status`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: started.id,
      status: 'active',
      draft: { hasPrd: false, issueCount: 0 },
    });
  });
});

describe('POST /api/projects/:id/grill/:sessionId/finish', () => {
  async function report(
    context: TestContext,
    sessionId: string,
    payload: unknown,
  ): Promise<Response> {
    const token = context.sessionRuntime.requests.at(-1)?.reportToken ?? '';
    return context.app.request(`/api/grill-sessions/${sessionId}/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  it('publishes the drafts as one Plan and its Issues', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await report(context, started.id, {
      prd: '# Plan (PRD)',
      issues: [
        {
          title: 'Save a bookmark',
          body: 'Persist a bookmark.',
          labels: ['ready'],
          depends_on: [],
        },
      ],
    });

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/finish`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: { status: 'finished' },
      plan: { contentMarkdown: '# Plan (PRD)', source: 'grill-me', version: 1 },
      issues: [{ title: 'Save a bookmark', planId: expect.any(String) }],
    });
    const retried = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/finish`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(retried.status).toBe(200);
    const storedPlans = await context.plans.list(projectId);
    expect(storedPlans.ok && storedPlans.value).toHaveLength(1);
    const storedIssues = await context.issues.list(projectId);
    expect(storedIssues.ok && storedIssues.value).toHaveLength(1);
  });

  it('returns a conflict naming the missing drafts, and a forced Finish still publishes', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await report(context, started.id, { prd: '# Only a PRD' });

    const conflict = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/finish`,
      { method: 'POST', body: JSON.stringify({}) },
    );

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: 'incomplete',
      missing: ['issues'],
    });

    const forced = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/finish`,
      { method: 'POST', body: JSON.stringify({ force: true }) },
    );

    expect(forced.status).toBe(200);
    await expect(forced.json()).resolves.toMatchObject({
      session: { status: 'finished' },
      plan: { contentMarkdown: '# Only a PRD' },
      issues: [],
    });
  });

  it('discards the drafts when the session is cancelled', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await report(context, started.id, { prd: '# A PRD' });

    const cancelled = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/cancel`,
      { method: 'POST' },
    );

    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({
      draft: { hasPrd: false, issueCount: 0 },
    });
    const storedPlans = await context.plans.list(projectId);
    expect(storedPlans.ok && storedPlans.value).toHaveLength(0);
  });
});

describe('GET /api/projects/:id/grill/:sessionId/terminal', () => {
  it('reports that WebSockets are unavailable when no upgrader is injected', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/terminal`,
    );

    expect(res.status).toBe(501);
  });

  it('returns 404 for an ended session', async () => {
    const { context, session } = await signedIn();
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);
    await request(context, session, `/api/projects/${projectId}/grill/${started.id}/cancel`, {
      method: 'POST',
    });

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/terminal`,
    );

    expect(res.status).toBe(404);
  });

  it('keeps the upstream terminal alive across a browser refresh', async () => {
    const bridge = fakeTerminalBridge();
    let events: WSEvents | undefined;
    const upgrade = ((_c: Parameters<UpgradeWebSocket>[0], nextEvents: WSEvents) => {
      events = nextEvents;
      return new Response(null);
    }) as unknown as UpgradeWebSocket;
    const context = createTestContext(undefined, undefined, {
      upgradeWebSocket: upgrade,
      grillRoutesOptions: { terminalBridgeFactory: bridge.factory },
    });
    const session = await signIn(context);
    const projectId = await createProject(context);
    const started = await startSession(context, session, projectId);

    const res = await request(
      context,
      session,
      `/api/projects/${projectId}/grill/${started.id}/terminal`,
    );
    expect(res.status).toBe(200);
    expect(events).toBeDefined();

    const first = fakeWebSocket();
    events!.onOpen!(new Event('open'), first.ws);
    expect(bridge.created).toBe(1);
    bridge.options.onReady?.();
    expect(first.messages).toContainEqual({ type: 'status', status: 'live' });

    // Refreshing closes the browser socket; the upstream ttyd connection and
    // OpenCode process must survive.
    events!.onClose!(new CloseEvent('close'), first.ws);
    expect(bridge.closed).toBe(false);

    const second = fakeWebSocket();
    events!.onOpen!(new Event('open'), second.ws);
    expect(bridge.created).toBe(1);
    expect(second.messages).toContainEqual({ type: 'status', status: 'live' });

    events!.onMessage!(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'input', data: 'ls\r' }),
      }),
      second.ws,
    );
    expect(bridge.input).toEqual(['ls\r']);

    await request(context, session, `/api/projects/${projectId}/grill/${started.id}/cancel`, {
      method: 'POST',
    });
    expect(bridge.closed).toBe(true);
    expect(second.closed).toEqual({ code: 1000, reason: 'session ended' });
  });
});
