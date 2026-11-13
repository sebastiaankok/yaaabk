import { describe, expect, it } from 'vitest';
import { createTestContext, signIn } from './test-support';

describe('GET /health', () => {
  it('reports the service as ok without a session', async () => {
    const { app } = createTestContext();

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('GET /api/skill-levels', () => {
  it('rejects an unauthenticated request', async () => {
    const { app } = createTestContext();

    const res = await app.request('/api/skill-levels');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid-session' });
  });

  it('lists the skill levels for a signed-in Developer', async () => {
    const context = createTestContext();
    const session = await signIn(context);

    const res = await context.app.request('/api/skill-levels', {
      headers: { cookie: `yaaabk_session=${session}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ skillLevels: ['beginner', 'expert'] });
  });
});
