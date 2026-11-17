/**
 * The browser end of the terminal protocol.
 *
 * Kept separate from the Svelte component so reconnect, resize and input
 * translation can be tested without a DOM or a real WebSocket.
 */

import type { BrowserTerminalMessage, TerminalServerMessage, TerminalSize } from '@yaaabk/grill-me';

export type TerminalConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/** The human label for a connection status, shared by the header pill and overlay. */
export function terminalStatusLabel(status: TerminalConnectionStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'closed':
      return 'Closed';
  }
}

/** The colour tone a status uses wherever the UI signals terminal health. */
export type TerminalStatusTone = 'emerald' | 'amber' | 'neutral';

export function terminalStatusTone(status: TerminalConnectionStatus): TerminalStatusTone {
  switch (status) {
    case 'live':
      return 'emerald';
    case 'connecting':
    case 'reconnecting':
      return 'amber';
    case 'closed':
      return 'neutral';
  }
}

/** The slice of a browser WebSocket the client needs. */
export interface TerminalSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** What the client drives: xterm in production, a fake in tests. */
export interface TerminalSink {
  write(data: string): void;
  title?(title: string): void;
  preferences?(json: string): void;
  onInput(handler: (data: string) => void): () => void;
  onResize(handler: (size: TerminalSize) => void): () => void;
}

export interface TerminalClientOptions {
  url: string;
  sink: TerminalSink;
  socketFactory?: (url: string) => TerminalSocketLike;
  onStatus?: (status: TerminalConnectionStatus, reason?: string) => void;
  /** Delay before reconnecting a dropped socket. Defaults to 500 ms. */
  reconnectDelayMs?: number;
}

export interface TerminalClient {
  connect(): void;
  /** Sets the terminal size and sends it as soon as the socket can carry it. */
  resize(size: TerminalSize): void;
  dispose(): void;
}

const OPEN = 1;

function parseServerMessage(raw: unknown): TerminalServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['type'] === 'output' && typeof value['data'] === 'string') {
      return { type: 'output', data: value['data'] };
    }
    if (value['type'] === 'title' && typeof value['data'] === 'string') {
      return { type: 'title', data: value['data'] };
    }
    if (value['type'] === 'preferences' && typeof value['data'] === 'string') {
      return { type: 'preferences', data: value['data'] };
    }
    if (
      value['type'] === 'status' &&
      (value['status'] === 'connecting' ||
        value['status'] === 'live' ||
        value['status'] === 'closed')
    ) {
      return {
        type: 'status',
        status: value['status'],
        ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Connects xterm to a session terminal, resizing and reconnecting as needed. */
export function createTerminalClient(options: TerminalClientOptions): TerminalClient {
  const socketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as TerminalSocketLike);
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  let socket: TerminalSocketLike | null = null;
  let size: TerminalSize | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let live = false;
  let replayRequested = false;
  let disposed = false;

  function status(next: TerminalConnectionStatus, reason?: string): void {
    options.onStatus?.(next, reason);
  }

  function send(message: BrowserTerminalMessage): void {
    if (socket === null || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function sendResize(): void {
    if (size === null) return;
    send({ type: 'resize', columns: size.columns, rows: size.rows });
  }

  /**
   * Makes OpenCode replay the settled history into the fresh terminal.
   *
   * ttyd only delivers `SIGWINCH` when the PTY size actually changes, and
   * OpenCode replays on resize. A refresh normally fits to the same
   * dimensions, so an unchanged resize would leave the new xterm blank. Nudge
   * one row first and then restore the real size.
   */
  function requestReplay(): void {
    if (size === null || replayRequested) return;
    replayRequested = true;
    send({ type: 'resize', columns: size.columns, rows: size.rows + 1 });
    sendResize();
  }

  const unsubscribeInput = options.sink.onInput((data) => {
    send({ type: 'input', data });
  });

  const unsubscribeResize = options.sink.onResize(storeSize);

  function storeSize(next: TerminalSize): void {
    size = next;
    if (live && !replayRequested) requestReplay();
    else sendResize();
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, reconnectDelayMs);
  }

  function open(): void {
    if (disposed) return;
    status('connecting');
    const next = socketFactory(options.url);
    socket = next;

    next.onopen = () => {
      live = true;
      replayRequested = false;
      requestReplay();
    };

    next.onmessage = (event: { data: unknown }) => {
      const message = parseServerMessage(event.data);
      if (message === null) return;
      if (message.type === 'output') options.sink.write(message.data);
      else if (message.type === 'title') options.sink.title?.(message.data);
      else if (message.type === 'preferences') options.sink.preferences?.(message.data);
      else status(message.status, message.reason);
    };

    next.onclose = (event: { code?: number; reason?: string }) => {
      if (socket === next) socket = null;
      live = false;
      replayRequested = false;
      if (disposed) return;
      status('reconnecting', event.reason);
      scheduleReconnect();
    };

    next.onerror = () => {
      if (socket === next) socket = null;
      live = false;
      replayRequested = false;
      if (disposed) return;
      status('reconnecting', 'terminal connection failed');
      scheduleReconnect();
    };
  }

  return {
    connect() {
      if (disposed) return;
      if (socket !== null) return;
      open();
    },
    resize(next) {
      storeSize(next);
    },
    dispose() {
      disposed = true;
      unsubscribeInput();
      unsubscribeResize();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close(1000, 'page closed');
      socket = null;
      status('closed');
    },
  };
}
