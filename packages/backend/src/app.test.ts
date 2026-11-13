import { describe, expect, it } from 'vitest';
import { app } from './app';

describe('GET /health', () => {
  it('reports the service as ok', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('GET /api/skill-levels', () => {
  it('lists the skill levels a Developer can choose', async () => {
    const res = await app.request('/api/skill-levels');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ skillLevels: ['beginner', 'expert'] });
  });
});
