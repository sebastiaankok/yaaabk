import { describe, expect, it } from 'vitest';
import { SESSION_PROMPT_ENV, supervisedCommand, supervisorSessionName } from './supervisor';

describe('the supervised session command', () => {
  it('keeps the opening prompt out of the ttyd command line', () => {
    const prompt = 'An active Plan can be several thousand bytes long. '.repeat(60);

    const args = supervisedCommand('tmux', 'ses_abc', 'opencode', 'openrouter/test-model');

    // ttyd 1.7.7 sprintf's the whole command line into a 4096-byte stack
    // buffer for its window title. Anything longer segfaults on the first
    // terminal client, so the prompt travels in the environment instead.
    expect(args.join(' ')).not.toContain(prompt);
    expect(args.join(' ').length).toBeLessThan(1024);
    expect(args).toEqual(
      expect.arrayContaining([expect.stringContaining(`"$${SESSION_PROMPT_ENV}"`)]),
    );
  });

  it('reduces the OpenCode session id to a tmux-safe name', () => {
    expect(supervisorSessionName('ses.abc:def')).toBe('yaaabk-ses-abc-def');
  });
});
