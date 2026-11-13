import type { GrillMeEventName, GrillMeModule } from './types';

/** How often a keep-alive comment is sent when the stream is idle. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

const ALL_EVENTS: readonly GrillMeEventName[] = [
  'token',
  'question',
  'plan_ready',
  'issues_generated',
  'error',
  'ended',
];

/** Encodes one Server-Sent Event frame. */
export function sseFrame(event: GrillMeEventName, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A keep-alive comment frame; comments are ignored by `EventSource`. */
export function sseHeartbeat(): string {
  return ': keep-alive\n\n';
}

export interface SseStreamOptions {
  /** Forward only these events. Defaults to all of them. */
  events?: readonly GrillMeEventName[];
  /** Idle keep-alive interval. Defaults to {@link DEFAULT_HEARTBEAT_MS}; 0 disables it. */
  heartbeatMs?: number;
}

/**
 * Adapts one session's module events into a Server-Sent Events byte stream.
 *
 * The stream filters out other sessions' events, forwards each one as an
 * `event:`/`data:` frame, and closes once the session ends. The backend hands
 * the returned stream straight to Hono's `streamSSE` (or any HTTP layer), so
 * the module itself stays free of transport concerns.
 */
export function createSseStream(
  module: GrillMeModule,
  sessionId: string,
  options: SseStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = options.events ?? ALL_EVENTS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const disposers: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  /** Stops the heartbeat and unsubscribes from the module. Idempotent. */
  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    for (const dispose of disposers) {
      dispose();
    }
  }

  function close(controller: ReadableStreamDefaultController<Uint8Array>): void {
    cleanup();
    try {
      controller.close();
    } catch {
      // Already closed by the consumer.
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        disposers.push(
          module.on(event, (payload) => {
            if (closed) {
              return;
            }
            if ((payload as { sessionId?: string }).sessionId !== sessionId) {
              return;
            }
            controller.enqueue(encoder.encode(sseFrame(event, payload)));
            if (event === 'ended') {
              close(controller);
            }
          }),
        );
      }

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(sseHeartbeat()));
          }
        }, heartbeatMs);
      }
    },
    cancel() {
      cleanup();
    },
  });
}
