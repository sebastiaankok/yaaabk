/**
 * The SessionRuntime port.
 *
 * A Grill-Me Session runs OpenCode behind ttyd in some environment: a local
 * child process on a development machine, or a Kubernetes Pod in a deployment.
 * The session orchestrator only depends on this narrow port, so the risky
 * orchestration logic is testable without a cluster or a real terminal.
 */

import type { ProjectMode } from '@yaaabk/shared';

/** Where a runtime currently is. */
export type SessionRuntimeState = 'starting' | 'ready' | 'failed' | 'stopped';

/** The connection details a terminal proxy needs. */
export interface SessionTerminalEndpoint {
  /** ttyd's WebSocket URL, e.g. `ws://127.0.0.1:41000/ws`. */
  url: string;
  /** Credential ttyd requires on the WebSocket handshake, when any. */
  credential?: { username: string; token: string };
}

/** A started runtime, addressed by session. */
export interface SessionRuntimeRef {
  sessionId: string;
  projectId: string;
  /** Which adapter owns the runtime: `local` or `kubernetes`. */
  provider: string;
  /** Adapter-specific handle: a PID or a Pod name. */
  handle: string;
  /**
   * The Kubernetes Namespace the runtime lives in. Persisted with the ref so a
   * restarted backend can inspect and stop a runtime it no longer remembers.
   */
  namespace?: string;
  terminal: SessionTerminalEndpoint;
}

/** What a spec must provide to start one session runtime. */
export interface SessionRuntimeSpec {
  /**
   * The YAAABK session id, also passed to `opencode --session`, so it must
   * start with `ses`.
   */
  sessionId: string;
  projectId: string;
  projectName: string;
  /** The Project's Kubernetes Namespace. Required by the Kubernetes adapter. */
  namespace?: string;
  /** The Project's repository, `owner/name`. Required to clone in Kubernetes. */
  repoFullName?: string;
  /**
   * Short-lived, read-only token the runtime clones the repository with. The
   * Kubernetes adapter mounts it only into the clone init container.
   */
  gitToken?: string;
  idea: string;
  mode: ProjectMode;
  /** The opening prompt, already built by the orchestrator. */
  prompt: string;
  /** The OpenCode model in `provider/model` form. */
  model: string;
  /**
   * Budget-limited OpenRouter key the runtime's OpenCode process uses. It is
   * injected into the runtime only and never appears in a session view.
   */
  openRouterKey?: string;
  /**
   * Bearer token the session's reporting MCP server presents to the backend.
   * Injected into the runtime only; it never appears in a session view.
   */
  reportToken?: string;
  /** Backend base URL the session's reporting MCP server posts to. */
  apiUrl?: string;
}

/** The result of inspecting a runtime. */
export interface SessionRuntimeInspection {
  state: SessionRuntimeState;
  ready: boolean;
  /** Human-readable failure reason, when the runtime is failed. */
  reason?: string;
  terminal?: SessionTerminalEndpoint;
}

/** Kinds of failure the runtime port reports. */
export type SessionRuntimeErrorKind = 'invalid-input' | 'start-failed' | 'not-found' | 'unknown';

export interface SessionRuntimeError {
  kind: SessionRuntimeErrorKind;
  operation: string;
  message: string;
}

export type SessionRuntimeResult<T> =
  { ok: true; value: T } | { ok: false; error: SessionRuntimeError };

/** The narrow port both adapters satisfy. */
export interface SessionRuntime {
  /** Starts the runtime and resolves once ttyd is accepting connections. */
  start(spec: SessionRuntimeSpec): Promise<SessionRuntimeResult<SessionRuntimeRef>>;
  /** Stops the runtime. Idempotent for an already-stopped ref. */
  stop(ref: SessionRuntimeRef): Promise<SessionRuntimeResult<void>>;
  /** Reports the current state, including a failure reason. */
  inspect(ref: SessionRuntimeRef): Promise<SessionRuntimeResult<SessionRuntimeInspection>>;
  /** Lists runtimes that have not been stopped, optionally by Project. */
  list(filter?: { projectId?: string }): Promise<SessionRuntimeResult<SessionRuntimeRef[]>>;
}
