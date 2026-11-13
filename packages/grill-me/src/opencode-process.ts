import { spawn } from 'node:child_process';
import { consoleLogger, type GrillMeLogger } from './errors';
import type {
  OpenCodeProcess,
  OpenCodeProcessExit,
  OpenCodeSpawner,
  OpenCodeSessionRequest,
} from './process';

export interface OpenCodeSpawnerOptions {
  /** Executable to run. Defaults to `opencode`. */
  command?: string;
  /** Arguments placed before the prompt. Defaults to `['run']`. */
  args?: string[];
  /** Extra environment for the process, merged over `process.env`. */
  env?: Record<string, string>;
  /** Working directory for the process. */
  cwd?: string;
  logger?: GrillMeLogger;
}

/**
 * Spawns the real `opencode` CLI as a child process.
 *
 * This is the sidecar adapter: in a deployment YAAABK and its OpenCode sidecar
 * share a pod, so "the sidecar" is simply a local process. The exact CLI
 * invocation may need tuning against the installed OpenCode version, which is
 * why the module only ever depends on the {@link OpenCodeSpawner} port.
 *
 * The session context is passed both as the opening prompt argument and as
 * `YAAABK_*` environment variables, so a wrapper script can use either.
 */
export function createOpenCodeSpawner(options: OpenCodeSpawnerOptions = {}): OpenCodeSpawner {
  const logger = options.logger ?? consoleLogger;
  const command = options.command ?? 'opencode';
  const args = options.args ?? ['run'];

  function start(request: OpenCodeSessionRequest): Promise<OpenCodeProcess> {
    return new Promise<OpenCodeProcess>((resolve, reject) => {
      const child = spawn(command, [...args, request.prompt], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: {
          ...process.env,
          ...options.env,
          YAAABK_PROJECT_ID: request.projectId,
          YAAABK_SESSION_ID: request.sessionId,
          YAAABK_SKILL_LEVEL: request.skillLevel,
          YAAABK_SKILL_PATH: request.skillPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exited = new Promise<OpenCodeProcessExit>((resolveExit) => {
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => request.onOutput(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => request.onError?.(chunk));

      child.once('error', (error) => {
        logger.error('opencode process error', { message: error.message });
        reject(error);
      });

      child.once('spawn', () => {
        logger.info('opencode process started', { pid: child.pid, sessionId: request.sessionId });
        resolve({
          exited,
          send(message) {
            return new Promise<void>((resolveWrite, rejectWrite) => {
              child.stdin?.write(`${message}\n`, (error) => {
                if (error) {
                  rejectWrite(error);
                } else {
                  resolveWrite();
                }
              });
            });
          },
          async stop() {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM');
            }
            await exited;
          },
        });
      });
    });
  }

  return { spawn: start };
}
