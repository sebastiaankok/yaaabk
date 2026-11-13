/**
 * The low-level port the Grill-Me Module is built on.
 *
 * The module owns the session lifecycle and marker parsing; a spawner owns the
 * mechanics of starting and talking to an OpenCode process. It is intentionally
 * narrow (spawn, send, stop, exited) so the YAAABK logic is testable with
 * {@link createFakeSpawner} and no real process.
 */

import type { SkillLevel } from '@yaaabk/shared';

/** How a process finished. Mirrors Node's `close` event. */
export interface OpenCodeProcessExit {
  code: number | null;
  signal: string | null;
}

/** A running OpenCode process. */
export interface OpenCodeProcess {
  /** Writes one message (a line) to the process's stdin. */
  send(message: string): Promise<void>;
  /** Terminates the process; resolves once it has exited. Idempotent. */
  stop(): Promise<void>;
  /** Resolves when the process exits, however it exits. */
  readonly exited: Promise<OpenCodeProcessExit>;
}

/** Everything a spawner needs to start one grill-me session. */
export interface OpenCodeSessionRequest {
  sessionId: string;
  projectId: string;
  idea: string;
  skillLevel: SkillLevel;
  /** Absolute path to the grill-me skill the agent must load. */
  skillPath: string;
  /** The opening prompt, already built by the module. */
  prompt: string;
  /** Called for each stdout chunk, in order. */
  onOutput(chunk: string): void;
  /** Called for each stderr chunk, in order. */
  onError?(chunk: string): void;
}

export interface OpenCodeSpawner {
  spawn(request: OpenCodeSessionRequest): Promise<OpenCodeProcess>;
}
