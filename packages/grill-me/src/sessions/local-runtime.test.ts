import { describe, expect, it } from 'vitest';
import { createFakeLocalRuntime } from './fake-runtime';
import { sessionRuntimeContract } from './runtime-contract';
import { SESSION_PROMPT_ENV } from './supervisor';

const cases = sessionRuntimeContract(() => createFakeLocalRuntime().harness);

describe('local SessionRuntime contract', () => {
  for (const contractCase of cases) {
    it(contractCase.name, contractCase.run);
  }

  it('keeps the agent in a persistent tmux session so a terminal disconnect cannot kill it', async () => {
    const fake = createFakeLocalRuntime();
    const spec = fake.harness.spec({ sessionId: 'ses_abc' });

    await fake.runtime.start(spec);

    const args = fake.requests[0]?.args ?? [];
    expect(args.slice(args.indexOf('tmux'), args.indexOf('opencode'))).toEqual([
      'tmux',
      '-L',
      'yaaabk-ses_abc',
      'new-session',
      '-A',
      '-s',
      'yaaabk-ses_abc',
      'sh',
      '-c',
      expect.stringContaining('exec "$0" mini'),
    ]);
  });

  it('ends the tmux session when the runtime stops', async () => {
    const fake = createFakeLocalRuntime();
    const spec = fake.harness.spec({ sessionId: 'ses_abc' });
    const started = await fake.runtime.start(spec);
    if (!started.ok) throw new Error('start failed');

    await fake.runtime.stop(started.value);

    expect(fake.killedSupervisorSessions).toEqual(['yaaabk-ses_abc']);
  });

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
        'sh',
        '-c',
        expect.stringContaining(`--prompt "$${SESSION_PROMPT_ENV}"`),
        'opencode',
        spec.sessionId,
        'openrouter/test-model',
      ]),
    );
    // ttyd 1.7.7 overflows a fixed 4096-byte title buffer when its command line
    // is long, so the prompt must reach OpenCode through the environment.
    expect(request?.args).not.toContain(spec.prompt);
    expect(request?.env).toMatchObject({
      YAAABK_PROJECT_ID: spec.projectId,
      YAAABK_SESSION_ID: spec.sessionId,
      YAAABK_MODE: spec.mode,
      [SESSION_PROMPT_ENV]: spec.prompt,
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
