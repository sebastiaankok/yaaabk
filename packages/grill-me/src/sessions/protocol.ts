/**
 * The small protocols the terminal path speaks.
 *
 * Browser ↔ backend is JSON over a WebSocket. Backend ↔ ttyd is ttyd's own
 * one-byte-prefixed frame protocol with the `tty` subprotocol. Keeping both
 * translations here means the backend route and the frontend client agree on
 * one contract.
 */

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** JSON messages the browser sends to the backend. */
export type BrowserTerminalMessage =
  { type: 'input'; data: string } | ({ type: 'resize' } & TerminalSize);

/** JSON messages the backend sends to the browser. */
export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'title'; data: string }
  | { type: 'preferences'; data: string }
  | { type: 'status'; status: 'connecting' | 'live' | 'closed'; reason?: string };

/** A decoded frame from ttyd. */
export type TtydServerFrame =
  | { type: 'output'; data: string }
  | { type: 'title'; data: string }
  | { type: 'preferences'; data: string };

/** The first message ttyd expects: auth token plus the initial terminal size. */
export function ttydAuthMessage(size: TerminalSize, authToken = ''): string {
  return JSON.stringify({ AuthToken: authToken, columns: size.columns, rows: size.rows });
}

/** Encodes keyboard input for ttyd. */
export function ttydInput(data: string): string {
  return `0${data}`;
}

/** Encodes a resize event for ttyd. */
export function ttydResize(size: TerminalSize): string {
  return `1${JSON.stringify({ columns: size.columns, rows: size.rows })}`;
}

/** Decodes one server frame; unknown frame types are ignored. */
export function decodeTtydFrame(frame: string): TtydServerFrame | null {
  if (frame.length === 0) return null;
  const data = frame.slice(1);
  switch (frame[0]) {
    case '0':
      return { type: 'output', data };
    case '1':
      return { type: 'title', data };
    case '2':
      return { type: 'preferences', data };
    default:
      return null;
  }
}
