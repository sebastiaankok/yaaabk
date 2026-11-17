/**
 * The process supervisor that keeps a session's agent alive independently of
 * ttyd's per-client PTY.
 *
 * ttyd runs one command per WebSocket client and signals it when that client
 * disconnects. A Grill-Me Session must outlive the backend's terminal bridge,
 * so the agent runs inside a tmux session: ttyd serves a client that attaches
 * to it, and a reconnect attaches again instead of starting a fresh agent.
 */

/** The default supervisor executable, present in the agent and dev images. */
export const DEFAULT_SUPERVISOR_COMMAND = 'tmux';

/**
 * The tmux session name for a Grill-Me Session.
 *
 * tmux rejects names containing `:` or `.`, so the OpenCode session id is
 * reduced to a safe alphabet. The prefix also makes leaked sessions easy to
 * recognise in `tmux list-sessions`.
 */
export function supervisorSessionName(sessionId: string): string {
  const safe = sessionId
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64);
  return `yaaabk-${safe === '' ? 'session' : safe}`;
}

/**
 * The command line ttyd starts: `tmux new-session -A` creates the supervised
 * agent once and attaches to the same session on every later ttyd client.
 */
export function supervisedCommand(
  supervisorCommand: string,
  sessionId: string,
  opencodeCommand: string,
  opencodeArgs: string[],
): string[] {
  return [
    supervisorCommand,
    'new-session',
    '-A',
    '-s',
    supervisorSessionName(sessionId),
    opencodeCommand,
    ...opencodeArgs,
  ];
}
