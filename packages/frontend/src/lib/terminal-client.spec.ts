import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalClient,
  terminalStatusLabel,
  terminalStatusTone,
  type TerminalConnectionStatus,
  type TerminalSink,
  type TerminalSocketLike,
} from './terminal-client';
import type { TerminalSize } from '@yaaabk/grill-me';

function fakeSink() {
  const writes: string[] = [];
  const titles: string[] = [];
  const preferences: string[] = [];
  const inputHandlers = new Set<(data: string) => void>();
  const resizeHandlers = new Set<(size: TerminalSize) => void>();
  const sink: TerminalSink = {
    write: (data) => writes.push(data),
    title: (title) => titles.push(title),
    preferences: (json) => preferences.push(json),
    onInput(handler) {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    onResize(handler) {
      resizeHandlers.add(handler);
      return () => resizeHandlers.delete(handler);
    },
  };
  return {
    sink,
    writes,
    titles,
    preferences,
    input(data: string) {
      for (const handler of inputHandlers) handler(data);
    },
    resize(size: TerminalSize) {
      for (const handler of resizeHandlers) handler(size);
    },
    handlers: { input: inputHandlers, resize: resizeHandlers },
  };
}

function fakeSocket() {
  const sent: string[] = [];
  const socket: TerminalSocketLike = {
    readyState: 1,
    send(data) {
      sent.push(data);
    },
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return {
    socket,
    sent,
    open() {
      socket.onopen?.();
    },
    receive(data: string) {
      socket.onmessage?.({ data });
    },
    close(reason = '') {
      socket.onclose?.({ reason });
    },
    error() {
      socket.onerror?.({});
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const sink = fakeSink();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const statuses: Array<{ status: TerminalConnectionStatus; reason?: string }> = [];
  const client = createTerminalClient({
    url: 'ws://api/terminal',
    sink: sink.sink,
    reconnectDelayMs: 250,
    socketFactory: () => {
      const next = fakeSocket();
      sockets.push(next);
      return next.socket;
    },
    onStatus: (status, reason) =>
      statuses.push({ status, ...(reason === undefined ? {} : { reason }) }),
  });
  return { client, sink, sockets, statuses };
}

describe('terminal client', () => {
  it('sends input and resize messages once the socket is open', () => {
    const { client, sink, sockets } = setup();
    client.connect();
    const first = sockets[0]!;
    first.open();

    sink.input('ls\r');
    sink.resize({ columns: 120, rows: 40 });

    expect(first.sent).toEqual([
      '{"type":"input","data":"ls\\r"}',
      '{"type":"resize","columns":120,"rows":41}',
      '{"type":"resize","columns":120,"rows":40}',
    ]);
  });

  it('sends a size set before the socket opens, nudging it so OpenCode replays', () => {
    const { client, sockets } = setup();
    client.resize({ columns: 132, rows: 43 });
    client.connect();

    sockets[0]!.open();

    expect(sockets[0]!.sent).toEqual([
      '{"type":"resize","columns":132,"rows":44}',
      '{"type":"resize","columns":132,"rows":43}',
    ]);
  });

  it('requests a replay-triggering resize on every reconnect', () => {
    const { client, sink, sockets } = setup();
    client.connect();
    sockets[0]!.open();
    sink.resize({ columns: 100, rows: 30 });

    sockets[0]!.close('going away');
    vi.advanceTimersByTime(250);
    const second = sockets[1]!;
    second.open();

    expect(second.sent).toEqual([
      '{"type":"resize","columns":100,"rows":31}',
      '{"type":"resize","columns":100,"rows":30}',
    ]);
  });

  it('writes output, title and preference frames into the sink', () => {
    const { client, sink, sockets } = setup();
    client.connect();
    const first = sockets[0]!;
    first.open();

    first.receive('{"type":"output","data":"hello"}');
    first.receive('{"type":"title","data":"opencode"}');
    first.receive('{"type":"preferences","data":"{\\"fontSize\\":14}"}');
    first.receive('not json');
    first.receive('{"type":"unknown"}');

    expect(sink.writes).toEqual(['hello']);
    expect(sink.titles).toEqual(['opencode']);
    expect(sink.preferences).toEqual(['{"fontSize":14}']);
  });

  it('reconnects after a drop and reports the server status', () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    const first = sockets[0]!;
    first.open();
    first.receive('{"type":"status","status":"connecting"}');
    first.receive('{"type":"status","status":"live"}');

    first.close('going away');
    expect(statuses.at(-1)).toEqual({ status: 'reconnecting', reason: 'going away' });
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('reconnects after a socket error', () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    sockets[0]!.error();

    expect(statuses.at(-1)).toEqual({
      status: 'reconnecting',
      reason: 'terminal connection failed',
    });
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
  });

  it('stops reconnecting and unsubscribes when disposed', () => {
    const { client, sink, sockets, statuses } = setup();
    client.connect();
    sockets[0]!.open();

    client.dispose();
    vi.advanceTimersByTime(1_000);

    expect(sockets[0]!.socket.close).toHaveBeenCalledWith(1000, 'page closed');
    expect(sockets).toHaveLength(1);
    expect(sink.handlers.input.size).toBe(0);
    expect(sink.handlers.resize.size).toBe(0);
    expect(statuses.at(-1)).toEqual({ status: 'closed' });
  });
});

describe('terminal status presentation', () => {
  it('labels every connection status for the header pill and overlay', () => {
    expect(terminalStatusLabel('live')).toBe('Live');
    expect(terminalStatusLabel('connecting')).toBe('Connecting…');
    expect(terminalStatusLabel('reconnecting')).toBe('Reconnecting…');
    expect(terminalStatusLabel('closed')).toBe('Closed');
  });

  it('maps connection statuses onto the pill colour tones', () => {
    expect(terminalStatusTone('live')).toBe('emerald');
    expect(terminalStatusTone('connecting')).toBe('amber');
    expect(terminalStatusTone('reconnecting')).toBe('amber');
    expect(terminalStatusTone('closed')).toBe('neutral');
  });
});
