import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { isSkillLevel } from '@yaaabk/shared';
import {
  type SessionRuntime,
  type SessionRuntimeInspection,
  type SessionRuntimeRef,
  type SessionRuntimeSpec,
  type SessionTerminalEndpoint,
} from './runtime-types';
import {
  DEFAULT_SUPERVISOR_COMMAND,
  SESSION_PROMPT_ENV,
  supervisedCommand,
  supervisorSessionName,
} from './supervisor';

/** How a local process finished. Mirrors Node's `close` event. */
export interface LocalProcessExit {
  code: number | null;
  signal: string | null;
}

/** The slice of a child process the local runtime needs. */
export interface LocalProcess {
  pid: number;
  exited: Promise<LocalProcessExit>;
  /** Bounded stderr collected so a failed start can name its reason. */
  stderr(): string;
  /** Terminates the process (and its children); resolves once it exited. */
  stop(): Promise<void>;
}

export interface LocalProcessSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  detached: boolean;
}

/** Spawns one local process. Tests inject a scripted implementation. */
export type LocalProcessSpawner = (
  command: string,
  args: string[],
  options: LocalProcessSpawnOptions,
) => LocalProcess;

export interface LocalSessionRuntimeOptions {
  /** ttyd executable. Defaults to `ttyd`. */
  ttydCommand?: string;
  /** OpenCode executable ttyd runs. Defaults to `opencode`. */
  opencodeCommand?: string;
  /**
   * Process supervisor that keeps OpenCode alive when ttyd's client
   * disconnects. Defaults to `tmux`, which the dev image installs.
   */
  supervisorCommand?: string;
  /**
   * Ends a supervisor session on stop. Defaults to `tmux kill-session`,
   * ignoring a session that already ended. Tests inject a recorder.
   */
  killSupervisorSession?: (sessionName: string) => Promise<void>;
  /** Interface ttyd binds to. Defaults to loopback. */
  host?: string;
  /** Working directory for ttyd. Defaults to the backend's directory. */
  cwd?: string;
  /**
   * OpenCode config file for sessions, applied through `OPENCODE_CONFIG`.
   * Defaults to `YAAABK_SESSION_OPENCODE_CONFIG`. Agent Jobs do not load it.
   */
  opencodeConfig?: string;
  /** Extra environment for ttyd, merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /** Runs one child process. Defaults to `child_process.spawn`. */
  spawn?: LocalProcessSpawner;
  /** Checks whether ttyd is accepting connections. Defaults to an HTTP probe. */
  probe?: (endpoint: SessionTerminalEndpoint) => Promise<boolean>;
  /** Allocates a free loopback port. Defaults to asking the OS. */
  allocatePort?: () => Promise<number>;
  /** How long start waits for ttyd. Defaults to 20 seconds. */
  readinessTimeoutMs?: number;
  /** Pause between readiness probes. Defaults to 100 ms. */
  readinessPollMs?: number;
  /** Pause implementation. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Generates the ttyd credential. Defaults to a random 32-byte token. */
  credential?: () => { username: string; token: string };
  logger?: { info(message: string, fields?: Record<string, unknown>): void };
}

const LOOPBACK = '127.0.0.1';
const MAX_STDERR = 8 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Allocates a free loopback port by binding to port 0 and releasing it. */
function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) reject(new Error('Could not allocate a loopback port'));
        else resolve(port);
      });
    });
  });
}

function credentialHeader(endpoint: SessionTerminalEndpoint): Record<string, string> {
  if (endpoint.credential === undefined) return {};
  const raw = `${endpoint.credential.username}:${endpoint.credential.token}`;
  return { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
}

async function probeTtyd(endpoint: SessionTerminalEndpoint): Promise<boolean> {
  const httpUrl = endpoint.url.replace(/^ws/, 'http').replace(/\/ws$/, '/');
  try {
    const response = await fetch(httpUrl, {
      headers: credentialHeader(endpoint),
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The real spawner: detached process group so ttyd and its tmux client die together. */
const realSpawner: LocalProcessSpawner = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.detached,
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR);
  });

  const exited = new Promise<LocalProcessExit>((resolve) => {
    let settled = false;
    const finish = (exit: LocalProcessExit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once('close', (code, signal) => finish({ code, signal }));
    child.once('error', (error) => {
      stderr = `${stderr}${error.message}\n`.slice(-MAX_STDERR);
      finish({ code: null, signal: null });
    });
  });

  return {
    pid: child.pid ?? -1,
    exited,
    stderr: () => stderr.trim(),
    async stop() {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        const forced = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, 2_000);
        await exited;
        clearTimeout(forced);
      }
    },
  };
};

/** Ends a tmux session's isolated server without failing when it already exited. */
function killTmuxSession(supervisorCommand: string, sessionName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn(supervisorCommand, ['-L', sessionName, 'kill-server'], {
        stdio: 'ignore',
      });
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    } catch {
      resolve();
    }
  });
}

function validSpec(spec: SessionRuntimeSpec): string | undefined {
  if (typeof spec.sessionId !== 'string' || spec.sessionId.trim() === '') {
    return 'A session id is required';
  }
  if (typeof spec.projectId !== 'string' || spec.projectId.trim() === '') {
    return 'A project id is required';
  }
  if (typeof spec.projectName !== 'string' || spec.projectName.trim() === '') {
    return 'A project name is required';
  }
  if (typeof spec.idea !== 'string' || spec.idea.trim() === '') {
    return 'An idea is required';
  }
  if (!isSkillLevel(spec.skillLevel)) {
    return `"${String(spec.skillLevel)}" is not a valid skill level`;
  }
  if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
    return 'An opening prompt is required';
  }
  if (typeof spec.model !== 'string' || spec.model.trim() === '') {
    return 'A model is required';
  }
  return undefined;
}

interface RuntimeRecord {
  ref: SessionRuntimeRef;
  process: LocalProcess;
  state: 'starting' | 'ready' | 'failed' | 'stopped';
  reason?: string;
  stopping: boolean;
}

/**
 * Runs sessions as local child processes: ttyd in front of `opencode mini`.
 *
 * This is the development adapter. It deliberately shells out to the same
 * pinned binaries the agent image carries, so host development and a local
 * container exercise the same runtime shape as Kubernetes later will.
 */
export function createLocalSessionRuntime(
  options: LocalSessionRuntimeOptions = {},
): SessionRuntime {
  const ttydCommand = options.ttydCommand ?? 'ttyd';
  const opencodeCommand = options.opencodeCommand ?? 'opencode';
  const supervisorCommand = options.supervisorCommand ?? DEFAULT_SUPERVISOR_COMMAND;
  const killSupervisorSession =
    options.killSupervisorSession ??
    ((sessionName: string) => killTmuxSession(supervisorCommand, sessionName));
  const host = options.host ?? LOOPBACK;
  const cwd = options.cwd ?? process.cwd();
  const opencodeConfig = options.opencodeConfig ?? process.env['YAAABK_SESSION_OPENCODE_CONFIG'];
  const spawn = options.spawn ?? realSpawner;
  const probe = options.probe ?? probeTtyd;
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 20_000;
  const readinessPollMs = options.readinessPollMs ?? 100;
  const sleep = options.sleep ?? sleepFor;
  const credential =
    options.credential ?? (() => ({ username: 'yaaabk', token: randomBytes(32).toString('hex') }));
  const logger = options.logger ?? { info: () => {} };
  const records = new Map<string, RuntimeRecord>();

  function rememberExit(record: RuntimeRecord): void {
    void record.process.exited.then((exit) => {
      if (record.stopping || record.state === 'stopped') {
        record.state = 'stopped';
        return;
      }
      if (record.state === 'failed') return;
      record.state = 'failed';
      const stderr = record.process.stderr();
      record.reason =
        stderr !== ''
          ? `ttyd exited with code ${exit.code ?? 'null'}: ${stderr}`
          : `ttyd exited with code ${exit.code ?? 'null'}`;
      logger.info('local session runtime exited', {
        sessionId: record.ref.sessionId,
        reason: record.reason,
      });
    });
  }

  function failureReason(record: RuntimeRecord, exit: LocalProcessExit): string {
    const stderr = record.process.stderr();
    const code = exit.code === null ? 'null' : String(exit.code);
    return stderr === ''
      ? `ttyd exited with code ${code}`
      : `ttyd exited with code ${code}: ${stderr}`;
  }

  return {
    async start(spec) {
      const reason = validSpec(spec);
      if (reason !== undefined) {
        return { ok: false, error: { kind: 'invalid-input', operation: 'start', message: reason } };
      }
      if (records.has(spec.sessionId)) {
        return {
          ok: false,
          error: {
            kind: 'invalid-input',
            operation: 'start',
            message: `A runtime already exists for session "${spec.sessionId}"`,
          },
        };
      }

      let port: number;
      try {
        port = await allocatePort();
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'start-failed',
            operation: 'start',
            message: `Could not allocate a terminal port: ${messageOf(error)}`,
          },
        };
      }

      const ttydCredential = credential();
      const terminal: SessionTerminalEndpoint = {
        url: `ws://${host}:${port}/ws`,
        credential: ttydCredential,
      };
      const args = [
        '--port',
        String(port),
        '--interface',
        host,
        '--writable',
        '--credential',
        `${ttydCredential.username}:${ttydCredential.token}`,
        ...supervisedCommand(supervisorCommand, spec.sessionId, opencodeCommand, spec.model),
      ];

      let child: LocalProcess;
      try {
        child = spawn(ttydCommand, args, {
          cwd,
          env: {
            ...process.env,
            ...options.env,
            YAAABK_PROJECT_ID: spec.projectId,
            YAAABK_SESSION_ID: spec.sessionId,
            YAAABK_SKILL_LEVEL: spec.skillLevel,
            [SESSION_PROMPT_ENV]: spec.prompt,
            ...(spec.openRouterKey === undefined ? {} : { OPENROUTER_API_KEY: spec.openRouterKey }),
            ...(spec.reportToken === undefined ? {} : { YAAABK_REPORT_TOKEN: spec.reportToken }),
            ...(spec.apiUrl === undefined ? {} : { YAAABK_API_URL: spec.apiUrl }),
            ...(opencodeConfig === undefined ? {} : { OPENCODE_CONFIG: opencodeConfig }),
          },
          detached: true,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'start-failed',
            operation: 'start',
            message: `Could not start ttyd: ${messageOf(error)}`,
          },
        };
      }

      const ref: SessionRuntimeRef = {
        sessionId: spec.sessionId,
        projectId: spec.projectId,
        provider: 'local',
        handle: String(child.pid),
        terminal,
      };
      const record: RuntimeRecord = {
        ref,
        process: child,
        state: 'starting',
        stopping: false,
      };
      records.set(spec.sessionId, record);
      rememberExit(record);

      const deadline = Date.now() + readinessTimeoutMs;
      let exited: LocalProcessExit | undefined;
      void child.exited.then((exit) => {
        exited = exit;
      });

      for (;;) {
        if (exited !== undefined) {
          const message = failureReason(record, exited);
          record.state = 'failed';
          record.reason = message;
          return { ok: false, error: { kind: 'start-failed', operation: 'start', message } };
        }
        if (Date.now() >= deadline) {
          record.stopping = true;
          record.state = 'failed';
          record.reason = `ttyd did not become ready within ${readinessTimeoutMs} ms`;
          await child.stop();
          return {
            ok: false,
            error: { kind: 'start-failed', operation: 'start', message: record.reason },
          };
        }
        if (await probe(terminal)) {
          record.state = 'ready';
          logger.info('local session runtime ready', {
            sessionId: spec.sessionId,
            endpoint: terminal.url,
          });
          return { ok: true, value: ref };
        }
        await sleep(readinessPollMs);
      }
    },

    async stop(ref) {
      const record = records.get(ref.sessionId);
      if (record === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'stop',
            message: `No local runtime for session "${ref.sessionId}"`,
          },
        };
      }
      if (record.state === 'stopped') return { ok: true, value: undefined };
      record.stopping = true;
      record.state = 'stopped';
      await record.process.stop();
      await killSupervisorSession(supervisorSessionName(ref.sessionId));
      return { ok: true, value: undefined };
    },

    async inspect(ref) {
      const record = records.get(ref.sessionId);
      if (record === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not-found',
            operation: 'inspect',
            message: `No local runtime for session "${ref.sessionId}"`,
          },
        };
      }
      const inspection: SessionRuntimeInspection = {
        state: record.state,
        ready: record.state === 'ready',
        terminal: record.ref.terminal,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
      return { ok: true, value: inspection };
    },

    async list(filter = {}) {
      const refs = [...records.values()]
        .filter((record) => record.state !== 'stopped')
        .filter(
          (record) => filter.projectId === undefined || record.ref.projectId === filter.projectId,
        )
        .map((record) => record.ref);
      return { ok: true, value: refs };
    },
  };
}
