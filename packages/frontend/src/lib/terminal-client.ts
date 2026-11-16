/**
 * The browser end of the terminal protocol.
 *
 * Kept separate from the Svelte component so reconnect, resize and input
 * translation can be tested without a DOM or a real WebSocket.
 */

import type { BrowserTerminalMessage, TerminalServerMessage, TerminalSize } from '@yaaabk/grill-me';

export type TerminalConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

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

  const unsubscribeInput = options.sink.onInput((data) => {
    send({ type: 'input', data });
  });

  const unsubscribeResize = options.sink.onResize(storeSize);

  function storeSize(next: TerminalSize): void {
    size = next;
    sendResize();
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
      // A resize after reconnect makes OpenCode replay the settled history.
      sendResize();
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
      if (disposed) return;
      status('reconnecting', event.reason);
      scheduleReconnect();
    };

    next.onerror = () => {
      if (socket === next) socket = null;
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
