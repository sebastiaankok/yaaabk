import { describe, expect, it, vi } from 'vitest';
import { createTerminalBridge, type TtydSocket } from './terminal-bridge';
import { decodeTtydFrame, ttydAuthMessage, ttydInput, ttydResize } from './protocol';

function fakeSocket() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  const socket: TtydSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    close(code, reason) {
      closed = {
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      };
    },
  };
  return {
    socket,
    sent,
    get closed() {
      return closed;
    },
    open() {
      socket.onopen?.();
    },
    receive(data: string) {
      socket.onmessage?.({ data: new TextEncoder().encode(data).buffer });
    },
    close(reason = '') {
      socket.onclose?.({ reason });
    },
    error() {
      socket.onerror?.({});
    },
  };
}

function setup() {
  const upstream = fakeSocket();
  const output: string[] = [];
  const titles: string[] = [];
  const preferences: string[] = [];
  const closed: string[] = [];
  const errors: string[] = [];
  const ready = vi.fn();
  const createSocket = vi.fn(() => upstream.socket);
  const bridge = createTerminalBridge({
    endpoint: {
      url: 'ws://terminal/ws',
      credential: { username: 'yaaabk', token: 'secret' },
    },
    createSocket,
    initialSize: { columns: 100, rows: 30 },
    onOutput: (data) => output.push(data),
    onTitle: (title) => titles.push(title),
    onPreferences: (json) => preferences.push(json),
    onReady: ready,
    onClose: (reason) => closed.push(reason),
    onError: (reason) => errors.push(reason),
  });
  return { upstream, bridge, output, titles, preferences, closed, errors, ready, createSocket };
}

describe('protocol translation', () => {
  it('encodes the ttyd auth message with the initial size', () => {
    expect(ttydAuthMessage({ columns: 80, rows: 24 })).toBe(
      '{"AuthToken":"","columns":80,"rows":24}',
    );
  });

  it('encodes input and resize frames', () => {
    expect(ttydInput('ls\r')).toBe('0ls\r');
    expect(ttydResize({ columns: 120, rows: 40 })).toBe('1{"columns":120,"rows":40}');
  });

  it('decodes ttyd output, title and preference frames', () => {
    expect(decodeTtydFrame('0hello')).toEqual({ type: 'output', data: 'hello' });
    expect(decodeTtydFrame('1opencode')).toEqual({ type: 'title', data: 'opencode' });
    expect(decodeTtydFrame('2{"bell":false}')).toEqual({
      type: 'preferences',
      data: '{"bell":false}',
    });
    expect(decodeTtydFrame('9ignored')).toBeNull();
  });
});

describe('terminal bridge', () => {
  it('opens with the credential and tty subprotocol', () => {
    const { createSocket } = setup();

    expect(createSocket).toHaveBeenCalledWith('ws://terminal/ws', ['tty'], {
      headers: {
        authorization: `Basic ${Buffer.from('yaaabk:secret').toString('base64')}`,
      },
    });
  });

  it('sends the auth handshake and then translates queued input and resize', () => {
    const { upstream, bridge, ready } = setup();
    bridge.input('ls\r');
    bridge.resize({ columns: 120, rows: 40 });

    upstream.open();

    expect(upstream.sent).toEqual([
      ttydAuthMessage({ columns: 100, rows: 30 }, 'eWFhYWJrOnNlY3JldA=='),
      '0ls\r',
      '1{"columns":120,"rows":40}',
    ]);
    expect(ready).toHaveBeenCalledOnce();

    bridge.input('pwd\r');
    expect(upstream.sent.at(-1)).toBe('0pwd\r');
  });

  it('translates server frames to callbacks', () => {
    const { upstream, bridge, output, titles, preferences } = setup();
    upstream.open();
    bridge.resize({ columns: 80, rows: 24 });

    upstream.receive('0hello');
    upstream.receive('1opencode');
    upstream.receive('2{"fontSize":14}');

    expect(output).toEqual(['hello']);
    expect(titles).toEqual(['opencode']);
    expect(preferences).toEqual(['{"fontSize":14}']);
  });

  it('reports rejected credentials and upstream closes', () => {
    const { upstream, errors, closed } = setup();
    upstream.open();
    upstream.receive('0');
    upstream.receive('0again');
    upstream.close('going away');

    expect(errors).toEqual(['ttyd rejected the session credential']);
    expect(closed).toEqual(['terminal authentication failed']);
  });

  it('reports an unexpected close once', () => {
    const { upstream, closed } = setup();
    upstream.open();

    upstream.error();
    upstream.close('late close');

    expect(closed).toEqual(['terminal connection failed']);
  });

  it('closes the upstream without reporting it as a failure', () => {
    const { upstream, bridge, closed } = setup();
    upstream.open();

    bridge.close();

    expect(upstream.closed).toEqual({ code: 1000, reason: 'session ended' });
    expect(closed).toEqual([]);
  });
});
