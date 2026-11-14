import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  createProjectStream,
  deleteProject,
  getIssueSyncStatus,
  getStatus,
  listIssueRuns,
  listProjectRuns,
  listProjects,
  login,
  spawnAgent,
  syncIssues,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getStatus', () => {
  it('returns the parsed status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ setupComplete: true, authenticated: false })),
    );

    await expect(getStatus()).resolves.toEqual({ setupComplete: true, authenticated: false });
  });
});

describe('failed requests', () => {
  it('throws a typed ApiError carrying the backend code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: 'invalid-credentials', message: 'Incorrect username or password' },
          401,
        ),
      ),
    );

    await expect(login({ username: 'alice', password: 'nope' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'invalid-credentials',
      message: 'Incorrect username or password',
    });
  });
});

describe('request options', () => {
  it('posts JSON with cookies attached', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await login({ username: 'alice', password: 'secret' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/login$/),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});

describe('listProjects', () => {
  it('unwraps the projects array from the response envelope', async () => {
    const project = { id: 'p1', name: 'todo-app' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ projects: [project] })),
    );

    await expect(listProjects()).resolves.toEqual([project]);
  });
});

describe('createProject', () => {
  it('POSTs the details as camelCase JSON and returns the created project', async () => {
    const created = { id: 'p1', name: 'todo-app' };
    const fetchMock = vi.fn(async () => jsonResponse(created, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createProject({ name: 'todo-app', description: 'A todo list', skillLevel: 'expert' }),
    ).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'todo-app',
          description: 'A todo list',
          skillLevel: 'expert',
        }),
      }),
    );
  });
});

describe('createProjectStream', () => {
  function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('delivers progress events and resolves with the finished project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: progress\ndata: {"step":"repository","status":"started"}\n\n',
          'event: progress\ndata: {"step":"repository","status":"completed"}\n\n',
          'event: done\ndata: {"id":"p1","name":"todo-app"}\n\n',
        ]),
      ),
    );
    const events: unknown[] = [];

    const project = await createProjectStream(
      { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' },
      (event) => events.push(event),
    );

    expect(project).toEqual({ id: 'p1', name: 'todo-app' });
    expect(events).toEqual([
      { step: 'repository', status: 'started' },
      { step: 'repository', status: 'completed' },
    ]);
  });
  it('rejects with an ApiError when a frame reports failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: progress\ndata: {"step":"repository","status":"started"}\n\n',
          'event: error\ndata: {"error":{"kind":"repository","message":"repository quota exceeded"}}\n\n',
        ]),
      ),
    );
    const events: unknown[] = [];

    await expect(
      createProjectStream(
        { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' },
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      name: 'ApiError',
      code: 'repository',
      message: 'repository quota exceeded',
    });
    expect(events).toHaveLength(1);
  });

  it('rejects with an ApiError when the response is not a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'unauthorized', message: 'Sign in required' }, 401)),
    );

    await expect(
      createProjectStream(
        { name: 'todo-app', description: 'A todo list', skillLevel: 'expert' },
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ApiError', status: 401, code: 'unauthorized' });
  });
});

describe('deleteProject', () => {
  it('sends a DELETE to the encoded project path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('p 1');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p%201$/),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('issue sync', () => {
  it('reads the sync status', async () => {
    const status = { total: 2, synced: 0, pending: 2, lastSyncedAt: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(status)),
    );

    await expect(getIssueSyncStatus('p1')).resolves.toEqual(status);
  });

  it('POSTs a full sync cycle', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ push: {}, pull: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await syncIssues('p1');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/issues\/sync$/),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('agent runs', () => {
  it('lists the runs for an issue, unwrapping the envelope', async () => {
    const run = { id: 'r1', issueId: 'i1', status: 'success' };
    const fetchMock = vi.fn(async () => jsonResponse({ runs: [run] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listIssueRuns('p1', 'i 1')).resolves.toEqual([run]);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/issues\/i%201\/runs$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('spawns an agent without sending a key when none is given', async () => {
    const run = { id: 'r1', issueId: 'i1', status: 'queued' };
    const fetchMock = vi.fn(async () => jsonResponse(run, 202));
    vi.stubGlobal('fetch', fetchMock);

    await expect(spawnAgent('p1', 'i1')).resolves.toEqual(run);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/issues\/i1\/spawn$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
  });

  it('spawns an agent with an OpenRouter key when given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'r1' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await spawnAgent('p1', 'i1', { openrouterApiKey: 'sk-or-abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/issues\/i1\/spawn$/),
      expect.objectContaining({ body: JSON.stringify({ openrouterApiKey: 'sk-or-abc' }) }),
    );
  });

  it('lists every run for a project', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ runs: [{ id: 'r1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjectRuns('p1')).resolves.toEqual([{ id: 'r1' }]);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/agent-runs$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
