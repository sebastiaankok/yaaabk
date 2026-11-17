/**
 * Fakes for SessionRuntime tests.
 *
 * They execute no binaries and open no sockets: one satisfies the shared
 * contract against the local adapter's process/probe seams, and the other is a
 * simple scripted runtime the session orchestrator and backend tests use.
 */

import type { SessionKey, SessionKeyIssueResult, SessionKeyIssuer } from './keys';
import type {
  SessionRuntime,
  SessionRuntimeRef,
  SessionRuntimeResult,
  SessionRuntimeSpec,
  SessionRuntimeState,
} from './runtime-types';
import {
  createLocalSessionRuntime,
  type LocalProcess,
  type LocalProcessExit,
  type LocalProcessSpawner,
} from './local-runtime';
import type { SessionRuntimeContractHarness } from './runtime-contract';
import type { SkillLevel } from '@yaaabk/shared';

let pidSequence = 4000;
let sessionSequence = 0;

interface FakeProcess extends LocalProcess {
  readonly args: string[];
  readonly command: string;
  readonly stopped: boolean;
  exit(code: number | null, signal?: string | null): void;
  setStderr(value: string): void;
}

function createFakeProcess(command: string, args: string[]): FakeProcess {
  let resolveExit!: (exit: LocalProcessExit) => void;
  const exited = new Promise<LocalProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  let finished = false;
  let stopped = false;
  let stderr = '';

  const process: FakeProcess = {
    pid: ++pidSequence,
    args,
    command,
    exited,
    get stopped() {
      return stopped;
    },
    stderr: () => stderr,
    setStderr(value) {
      stderr = value;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (!finished) {
        finished = true;
        resolveExit({ code: null, signal: 'SIGTERM' });
      }
    },
    exit(code, signal = null) {
      if (finished) return;
      finished = true;
      resolveExit({ code, signal });
    },
  };
  return process;
}

export interface FakeLocalRuntime {
  runtime: SessionRuntime;
  harness: SessionRuntimeContractHarness;
  readonly requests: Array<{
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }>;
  readonly processes: FakeProcess[];
  /** Stops every process the fake started. */
  stopAll(): Promise<void>;
}

export interface FakeLocalRuntimeOptions {
  model?: string;
  readinessTimeoutMs?: number;
  opencodeConfig?: string;
}

/**
 * Builds the local adapter with scripted processes and a scripted readiness
 * probe, so the shared contract runs without ttyd or OpenCode.
 */
export function createFakeLocalRuntime(options: FakeLocalRuntimeOptions = {}): FakeLocalRuntime {
  const requests: FakeLocalRuntime['requests'] = [];
  const processes: FakeProcess[] = [];
  let failNext = false;
  let failingStart = false;
  let failureReason = '';

  const spawn: LocalProcessSpawner = (command, args, spawnOptions) => {
    requests.push({ command, args, env: spawnOptions.env });
    const child = createFakeProcess(command, args);
    processes.push(child);
    failingStart = failNext;
    if (failNext) {
      child.setStderr(failureReason);
      failNext = false;
      child.exit(1, null);
    }
    return child;
  };

  const runtime = createLocalSessionRuntime({
    spawn,
    probe: async () => !failingStart,
    allocatePort: async () => 41000 + requests.length,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 50,
    readinessPollMs: 1,
    sleep: async () => {},
    cwd: '/tmp',
    credential: () => ({ username: 'yaaabk', token: 'test-token' }),
    ...(options.opencodeConfig === undefined ? {} : { opencodeConfig: options.opencodeConfig }),
    logger: { info: () => {} },
  });

  function spec(overrides: Partial<SessionRuntimeSpec> = {}): SessionRuntimeSpec {
    sessionSequence += 1;
    return {
      sessionId: `session-${sessionSequence}`,
      projectId: `project-${sessionSequence}`,
      projectName: 'todo-app',
      idea: 'A todo app',
      skillLevel: 'expert' satisfies SkillLevel,
      prompt: 'Build a todo app',
      model: options.model ?? 'openrouter/test-model',
      reportToken: 'report-token',
      apiUrl: 'http://backend:3000',
      ...overrides,
    };
  }

  return {
    runtime,
    requests,
    processes,
    harness: {
      runtime,
      spec,
      failNextStart(reason) {
        failNext = true;
        failureReason = reason;
      },
    },
    async stopAll() {
      await Promise.all(processes.map((child) => child.stop()));
    },
  };
}

export interface FakeSessionKeys extends SessionKeyIssuer {
  /** Session ids a key was minted for, in order. */
  readonly issued: string[];
  /** Hashes revoked, in order. */
  readonly revoked: string[];
  /** Makes the next issue call fail with `message`. */
  failNext(message: string): void;
}

/** A scripted key issuer for orchestrator and route tests. */
export function createFakeSessionKeys(): FakeSessionKeys {
  const issued: string[] = [];
  const revoked: string[] = [];
  let failure: string | undefined;

  return {
    issued,
    revoked,
    failNext(message) {
      failure = message;
    },
    async issue(sessionId): Promise<SessionKeyIssueResult> {
      if (failure !== undefined) {
        const message = failure;
        failure = undefined;
        return { ok: false, message };
      }
      issued.push(sessionId);
      const value: SessionKey = {
        key: `sk-or-${sessionId}`,
        hash: `hash-${sessionId}`,
        expiresAt: '2030-01-01T00:00:00.000Z',
      };
      return { ok: true, value };
    },
    async revoke(hash) {
      revoked.push(hash);
    },
  };
}

export interface FakeSessionRuntimeOptions {
  /** The next start resolves to this error message instead of a ref. */
  startFailure?: string;
  /** Terminal URL prefix used in returned refs. */
  endpoint?: (sessionId: string) => string;
}

export interface FakeSessionRuntime extends SessionRuntime {
  readonly requests: SessionRuntimeSpec[];
  readonly refs: SessionRuntimeRef[];
  readonly stopped: SessionRuntimeRef[];
  /** Changes what the next start returns. */
  failNextStart(reason: string | undefined): void;
  /** Forgets a runtime, as a fresh adapter after a backend restart would. */
  forget(sessionId: string): void;
  /** Marks a runtime failed with the reason an inspection should report. */
  markFailed(sessionId: string, reason: string): void;
  /** Adds a runtime that no session owns, to exercise orphan cleanup. */
  addOrphan(ref: SessionRuntimeRef): void;
}

/** A scripted runtime for orchestrator and route tests. */
export function createFakeSessionRuntime(
  options: FakeSessionRuntimeOptions = {},
): FakeSessionRuntime {
  const requests: SessionRuntimeSpec[] = [];
  const refs: SessionRuntimeRef[] = [];
  const stopped: SessionRuntimeRef[] = [];
  const states = new Map<string, SessionRuntimeState>();
  const reasons = new Map<string, string>();
  let startFailure = options.startFailure;

  return {
    requests,
    refs,
    stopped,
    failNextStart(reason) {
      startFailure = reason;
    },
    forget(sessionId) {
      states.delete(sessionId);
      reasons.delete(sessionId);
    },
    markFailed(sessionId, reason) {
      states.set(sessionId, 'failed');
      reasons.set(sessionId, reason);
    },
    addOrphan(ref) {
      refs.push(ref);
      states.set(ref.sessionId, 'ready');
    },
    async start(spec) {
      requests.push(spec);
      if (startFailure !== undefined) {
        const message = startFailure;
        startFailure = undefined;
        return {
          ok: false,
          error: { kind: 'start-failed', operation: 'start', message },
        };
      }
      const ref: SessionRuntimeRef = {
        sessionId: spec.sessionId,
        projectId: spec.projectId,
        provider: 'fake',
        handle: `handle-${spec.sessionId}`,
        terminal: {
          url:
            options.endpoint?.(spec.sessionId) ??
            `ws://127.0.0.1:4100/ws?session=${spec.sessionId}`,
          credential: { username: 'yaaabk', token: 'test-token' },
        },
      };
      refs.push(ref);
      states.set(spec.sessionId, 'ready');
      return { ok: true, value: ref };
    },
    async stop(ref) {
      if (!states.has(ref.sessionId)) {
        return {
          ok: false,
          error: { kind: 'not-found', operation: 'stop', message: `No runtime ${ref.sessionId}` },
        };
      }
      states.set(ref.sessionId, 'stopped');
      stopped.push(ref);
      return { ok: true, value: undefined };
    },
    async inspect(ref) {
      const state = states.get(ref.sessionId);
      if (state === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'inspect',
            message: `No runtime ${ref.sessionId}`,
          },
        };
      }
      const reason = reasons.get(ref.sessionId);
      return {
        ok: true,
        value: {
          state,
          ready: state === 'ready',
          terminal: ref.terminal,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    },
    async list(filter = {}) {
      const live = refs.filter(
        (ref) =>
          states.get(ref.sessionId) !== 'stopped' &&
          (filter.projectId === undefined || ref.projectId === filter.projectId),
      );
      return { ok: true, value: live };
    },
  };
}

/** A verdict helper so tests can assert on a result without casts. */
export function expectOk<T>(result: SessionRuntimeResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
