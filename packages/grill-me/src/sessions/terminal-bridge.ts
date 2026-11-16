import {
  decodeTtydFrame,
  ttydAuthMessage,
  ttydInput,
  ttydResize,
  type TerminalSize,
} from './protocol';
import type { SessionTerminalEndpoint } from './runtime-types';

/** The slice of a WebSocket the bridge needs. */
export interface TtydSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type TtydSocketFactory = (
  url: string,
  protocols: string[],
  options: { headers?: Record<string, string> },
) => TtydSocket;

export interface TerminalBridgeOptions {
  endpoint: SessionTerminalEndpoint;
  createSocket?: TtydSocketFactory;
  initialSize?: TerminalSize;
  onOutput(data: string): void;
  onTitle?(title: string): void;
  onPreferences?(json: string): void;
  onReady?(): void;
  /** Called once when the upstream closes or fails; manual close is silent. */
  onClose?(reason: string): void;
  onError?(reason: string): void;
}

export interface TerminalBridge {
  input(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
}

function authorization(endpoint: SessionTerminalEndpoint): Record<string, string> {
  if (endpoint.credential === undefined) return {};
  const raw = `${endpoint.credential.username}:${endpoint.credential.token}`;
  return { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
}

/** ttyd expects the base64 `user:pass` credential in the first JSON frame. */
function authTokenOf(endpoint: SessionTerminalEndpoint): string {
  if (endpoint.credential === undefined) return '';
  return Buffer.from(
    `${endpoint.credential.username}:${endpoint.credential.token}`,
    'utf8',
  ).toString('base64');
}

/** Bun's global WebSocket; typed down to the bridge's narrow slice. */
const bunSocketFactory: TtydSocketFactory = (url, protocols, options) => {
  const Constructor = (
    globalThis as unknown as {
      WebSocket: new (
        url: string,
        options: { protocols?: string[]; headers?: Record<string, string> },
      ) => TtydSocket;
    }
  ).WebSocket;
  return new Constructor(url, { protocols, headers: options.headers });
};

/**
 * Translates the browser's small JSON protocol into ttyd frames and back.
 *
 * It owns the ttyd auth handshake, queues input until auth succeeds, and
 * reports an upstream close exactly once so the route can tell the browser.
 */
export function createTerminalBridge(options: TerminalBridgeOptions): TerminalBridge {
  const createSocket = options.createSocket ?? bunSocketFactory;
  const initialSize = options.initialSize ?? { columns: 80, rows: 24 };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const queue: string[] = [];
  let ready = false;
  let disposed = false;
  let closed = false;

  const socket = createSocket(options.endpoint.url, ['tty'], {
    headers: authorization(options.endpoint),
  });

  function reportClose(reason: string): void {
    if (closed || disposed) return;
    closed = true;
    options.onClose?.(reason);
  }

  /** Sends a ttyd frame. ttyd reads binary frames: command byte then payload. */
  function send(frame: string): void {
    if (disposed) return;
    if (ready) socket.send(encoder.encode(frame));
    else queue.push(frame);
  }

  /** ttyd frames are binary, with the command as the first byte. */
  function decodeSocketData(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    return null;
  }

  socket.onopen = () => {
    socket.send(encoder.encode(ttydAuthMessage(initialSize, authTokenOf(options.endpoint))));
    // ttyd does not acknowledge a successful credential handshake; it starts
    // the PTY immediately. Frames sent next are processed after the auth frame.
    ready = true;
    for (const frame of queue) socket.send(encoder.encode(frame));
    queue.length = 0;
    options.onReady?.();
  };

  socket.onmessage = (event) => {
    const raw = decodeSocketData(event.data);
    if (raw === null) return;
    if (raw === '0') {
      options.onError?.('ttyd rejected the session credential');
      reportClose('terminal authentication failed');
      return;
    }
    const frame = decodeTtydFrame(raw);
    if (frame === null || frame.data === '') return;
    if (frame.type === 'output') options.onOutput(frame.data);
    else if (frame.type === 'title') options.onTitle?.(frame.data);
    else options.onPreferences?.(frame.data);
  };

  socket.onclose = (event) => {
    const reason =
      event.reason === undefined || event.reason === '' ? 'terminal closed' : event.reason;
    reportClose(reason);
  };

  socket.onerror = () => {
    options.onError?.('terminal connection failed');
    reportClose('terminal connection failed');
  };

  return {
    input(data) {
      if (data !== '') send(ttydInput(data));
    },
    resize(size) {
      send(ttydResize(size));
    },
    close() {
      disposed = true;
      queue.length = 0;
      socket.close(1000, 'session ended');
    },
  };
}
