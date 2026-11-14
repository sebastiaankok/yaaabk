import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  deleteProject,
  getIssueSyncStatus,
  getStatus,
  listProjects,
  login,
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
