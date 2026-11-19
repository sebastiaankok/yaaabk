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
 * Environment variable carrying the opening prompt into the supervised pane.
 *
 * It must not travel as an argument: ttyd 1.7.7 formats its window title with
 * `sprintf` into a fixed 4096-byte stack buffer, so a command line longer than
 * that overflows the buffer and ttyd dies with SIGSEGV when the first terminal
 * client connects. An active Plan makes the prompt exceed that limit easily.
 */
export const SESSION_PROMPT_ENV = 'YAAABK_SESSION_PROMPT';

/**
 * The tmux session name for a Grill-Me Session.
 *
 * tmux rejects names containing `:` or `.`, so the OpenCode session id is
 * reduced to a safe alphabet. The prefix also makes leaked sessions easy to
 * recognise in `tmux list-sessions`.
 *
 * The same value names the tmux server's socket (`tmux -L`). A per-session
 * server keeps each pane's environment independent: tmux only copies a
 * whitelist of variables from later clients, so a shared server would hand a
 * new session the previous session's `SESSION_PROMPT_ENV`.
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
 *
 * Only the short, non-secret shape of the invocation is in the argument list.
 * The opening prompt is read from `SESSION_PROMPT_ENV` by the pane's shell, so
 * ttyd's fixed-size title buffer cannot overflow (see `SESSION_PROMPT_ENV`).
 */
export function supervisedCommand(
  supervisorCommand: string,
  sessionId: string,
  opencodeCommand: string,
  model: string,
): string[] {
  const name = supervisorSessionName(sessionId);
  return [
    supervisorCommand,
    '-L',
    name,
    'new-session',
    '-A',
    '-s',
    name,
    'sh',
    '-c',
    `exec "$0" mini --session "$1" --prompt "$${SESSION_PROMPT_ENV}" --model "$2" --replay --standalone`,
    opencodeCommand,
    sessionId,
    model,
  ];
}
