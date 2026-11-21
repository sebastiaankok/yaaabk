import { describe, expect, test } from 'bun:test';
import { app } from './app';

describe('{{projectName}} API', () => {
  test('reports health', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('greets the project by name', async () => {
    const response = await app.request('/api/hello');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Hello from {{projectName}}' });
  });

  test('answers an unknown API route with a JSON 404, not the SPA shell', async () => {
    const response = await app.request('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});
