import { describe, expect, it } from 'vitest';
import { createFakeLocalRuntime } from './fake-runtime';
import { sessionRuntimeContract } from './runtime-contract';

const cases = sessionRuntimeContract(() => createFakeLocalRuntime().harness);

describe('local SessionRuntime contract', () => {
  for (const contractCase of cases) {
    it(contractCase.name, contractCase.run);
  }

  it('runs opencode mini behind ttyd with the session prompt, model and replay', async () => {
    const fake = createFakeLocalRuntime();
    const spec = fake.harness.spec({
      idea: 'A recipe box',
      model: 'openrouter/test-model',
    });

    const started = await fake.runtime.start(spec);

    expect(started.ok).toBe(true);
    const request = fake.requests[0];
    expect(request?.command).toBe('ttyd');
    expect(request?.args).toEqual(
      expect.arrayContaining([
        '--writable',
        '--credential',
        expect.stringMatching(/^yaaabk:test-token$/),
        'opencode',
        'mini',
        '--session',
        spec.sessionId,
        '--prompt',
        spec.prompt,
        '--model',
        'openrouter/test-model',
        '--replay',
        '--standalone',
      ]),
    );
    expect(request?.env).toMatchObject({
      YAAABK_PROJECT_ID: spec.projectId,
      YAAABK_SESSION_ID: spec.sessionId,
      YAAABK_SKILL_LEVEL: spec.skillLevel,
      YAAABK_REPORT_TOKEN: 'report-token',
      YAAABK_API_URL: 'http://backend:3000',
    });
  });

  it('injects the session OpenRouter key only into the runtime environment', async () => {
    const fake = createFakeLocalRuntime();

    await fake.runtime.start(fake.harness.spec({ openRouterKey: 'sk-or-session-1' }));

    expect(fake.requests[0]?.env['OPENROUTER_API_KEY']).toBe('sk-or-session-1');
  });

  it('points sessions at the session OpenCode config without touching Agent Jobs', async () => {
    const fake = createFakeLocalRuntime({ opencodeConfig: '/app/opencode-session.json' });

    await fake.runtime.start(fake.harness.spec());

    expect(fake.requests[0]?.env).toMatchObject({
      OPENCODE_CONFIG: '/app/opencode-session.json',
    });
  });
});
