import { SKILL_LEVELS } from '@yaaabk/shared';
import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/skill-levels', (c) => c.json({ skillLevels: SKILL_LEVELS }));
