import { silentLogger, type GrillMeLogger } from './errors';
import type {
  OpenCodeProcess,
  OpenCodeProcessExit,
  OpenCodeSessionRequest,
  OpenCodeSpawner,
} from './process';

/**
 * A scripted stand-in for an OpenCode process.
 *
 * Tests drive it directly: `emit` plays stdout (the marker protocol), `sent`
 * records what the module wrote to stdin, and `exit` simulates the process
 * finishing on its own.
 */
export interface FakeProcess extends OpenCodeProcess {
  readonly request: OpenCodeSessionRequest;
  /** Every message written to stdin, in order. */
  readonly sent: string[];
  /** Whether `stop()` was called. */
  readonly stopped: boolean;
  /** Plays a stdout chunk, as if the process wrote it. */
  emit(chunk: string): void;
  /** Plays a stderr chunk. */
  emitError(chunk: string): void;
  /** Resolves the process's exit, as if it finished on its own. */
  exit(code?: number): void;
}

export interface FakeSpawner extends OpenCodeSpawner {
  /** Every spawn request, in order. */
  readonly requests: OpenCodeSessionRequest[];
  /** Every process spawned, in order. */
  readonly processes: FakeProcess[];
  /** The most recently spawned process. */
  last(): FakeProcess;
}

export interface FakeSpawnerOptions {
  /** When set, `spawn` rejects with this message, simulating a failed launch. */
  spawnError?: string;
  logger?: GrillMeLogger;
}

function createFakeProcess(request: OpenCodeSessionRequest): FakeProcess {
  const sent: string[] = [];
  let stopped = false;
  let finished = false;
  let resolveExit!: (exit: OpenCodeProcessExit) => void;
  const exited = new Promise<OpenCodeProcessExit>((resolve) => {
    resolveExit = resolve;
  });

  function finish(exit: OpenCodeProcessExit): void {
    if (!finished) {
      finished = true;
      resolveExit(exit);
    }
  }

  return {
    request,
    sent,
    exited,
    get stopped() {
      return stopped;
    },
    async send(message) {
      sent.push(message);
    },
    async stop() {
      stopped = true;
      finish({ code: null, signal: 'SIGTERM' });
    },
    emit(chunk) {
      request.onOutput(chunk);
    },
    emitError(chunk) {
      request.onError?.(chunk);
    },
    exit(code = 0) {
      finish({ code, signal: null });
    },
  };
}

/** Builds an {@link OpenCodeSpawner} for tests, backed by {@link FakeProcess}es. */
export function createFakeSpawner(options: FakeSpawnerOptions = {}): FakeSpawner {
  const logger = options.logger ?? silentLogger;
  const requests: OpenCodeSessionRequest[] = [];
  const processes: FakeProcess[] = [];

  return {
    requests,
    processes,
    last() {
      const process = processes.at(-1);
      if (process === undefined) {
        throw new Error('No process has been spawned yet');
      }
      return process;
    },
    async spawn(request) {
      if (options.spawnError !== undefined) {
        logger.error('fake spawn failed', { message: options.spawnError });
        throw new Error(options.spawnError);
      }
      requests.push(request);
      const process = createFakeProcess(request);
      processes.push(process);
      return process;
    },
  };
}
