import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  createProjectStream,
  deleteProject,
  exportProject,
  finishGrill,
  getIssueSyncStatus,
  getOverview,
  getProjectOverview,
  getProjectStats,
  getStatus,
  listIssueRuns,
  listModels,
  listProjectRuns,
  listProjects,
  login,
  spawnAgent,
  startGrill,
  syncIssues,
  updateProject,
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

  it('carries the missing drafts a Finish conflict names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: 'incomplete',
            message: 'Cannot finish: a PRD missing',
            missing: ['prd'],
          },
          409,
        ),
      ),
    );

    await expect(finishGrill('p1', 's1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'incomplete',
      missing: ['prd'],
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

describe('listModels', () => {
  it('returns the catalogue and default model', async () => {
    const body = {
      models: [
        {
          id: 'openrouter/anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          contextLength: 200000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 15,
        },
      ],
      defaultModel: 'openrouter/anthropic/claude-sonnet-4.5',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(body)),
    );

    await expect(listModels()).resolves.toEqual(body);
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
      createProject({ name: 'todo-app', description: 'A todo list', mode: 'guided' }),
    ).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'todo-app',
          description: 'A todo list',
          mode: 'guided',
        }),
      }),
    );
  });
});

describe('updateProject', () => {
  it('PATCHes the agent model and returns the updated project', async () => {
    const updated = { id: 'p1', agentModel: 'openrouter/chosen' };
    const fetchMock = vi.fn(async () => jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateProject('p1', { agentModel: 'openrouter/chosen' })).resolves.toEqual(
      updated,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1$/),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ agentModel: 'openrouter/chosen' }),
      }),
    );
  });
});

describe('exportProject', () => {
  it('POSTs the target owner and repo name and returns the updated project', async () => {
    const updated = { id: 'p1', repoFullName: 'dev/todo' };
    const fetchMock = vi.fn(async () => jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportProject('p1', { owner: 'dev', repoName: 'todo' })).resolves.toEqual(updated);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/export$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ owner: 'dev', repoName: 'todo' }),
      }),
    );
  });

  it('omits the repo name when the project name is kept', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'p1' }));
    vi.stubGlobal('fetch', fetchMock);

    await exportProject('p1', { owner: 'dev', repoName: '' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: JSON.stringify({ owner: 'dev' }) }),
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
      { name: 'todo-app', description: 'A todo list', mode: 'guided' },
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
        { name: 'todo-app', description: 'A todo list', mode: 'guided' },
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
        { name: 'todo-app', description: 'A todo list', mode: 'guided' },
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
    const res = { runs: [{ id: 'r1' }] };
    const fetchMock = vi.fn(async () => jsonResponse(res));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjectRuns('p1')).resolves.toEqual([{ id: 'r1' }]);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/agent-runs$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('project overviews', () => {
  it('loads every project overview in one request', async () => {
    const overviews = [{ project: { id: 'p1' }, activePlan: null, activeWork: [] }];
    const fetchMock = vi.fn(async () => jsonResponse({ overviews }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getOverview()).resolves.toEqual(overviews);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/overview$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('loads one project overview by its encoded id', async () => {
    const overview = { project: { id: 'p 1' }, activePlan: null, activeWork: [] };
    const fetchMock = vi.fn(async () => jsonResponse(overview));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getProjectOverview('p 1')).resolves.toEqual(overview);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p%201\/overview$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('getProjectStats', () => {
  it('requests the project stats with an optional date range', async () => {
    const stats = { issues: { total: 0 }, agents: { total: 0 } };
    const fetchMock = vi.fn(async () => jsonResponse(stats));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getProjectStats('p 1', {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      }),
    ).resolves.toEqual(stats);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/api\/projects\/p%201\/stats\?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z$/,
      ),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('omits the query string when no range is given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await getProjectStats('p1');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/stats$/),
      expect.anything(),
    );
  });
});

describe('startGrill', () => {
  it('sends the selected session mode with the idea and model', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 's1' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await startGrill('p1', 'A todo app', 'openrouter/chosen', 'autonomous');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/grill$/),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          idea: 'A todo app',
          model: 'openrouter/chosen',
          mode: 'autonomous',
        }),
      }),
    );
  });

  it('omits the mode when the caller leaves it to the Project', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 's1' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await startGrill('p1', 'A todo app');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p1\/grill$/),
      expect.objectContaining({ body: JSON.stringify({ idea: 'A todo app' }) }),
    );
  });
});

describe('finishGrill', () => {
  it('publishes the drafts and returns the Plan and Issues', async () => {
    const published = { session: {}, plan: { id: 'v1' }, issues: [] };
    const fetchMock = vi.fn(async () => jsonResponse(published));
    vi.stubGlobal('fetch', fetchMock);

    await expect(finishGrill('p 1', 's 1')).resolves.toEqual(published);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/projects\/p%201\/grill\/s%201\/finish$/),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ force: false }) }),
    );
  });

  it('asks for a forced publish when the caller overrides the guard', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await finishGrill('p1', 's1', { force: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/finish$/),
      expect.objectContaining({ body: JSON.stringify({ force: true }) }),
    );
  });
});
