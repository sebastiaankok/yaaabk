/**
 * Public domain types for the Grill-Me Module.
 *
 * Failures never cross the module boundary as exceptions: every command
 * resolves to a {@link GrillMeResult}, matching the K8s Client and Template
 * modules' contract. Output, by contrast, is pushed to subscribers as events.
 */

import type { SkillLevel } from '@yaaabk/shared';

/** The kinds of failure a grill-me command can report. */
export type GrillMeErrorKind =
  | 'invalid-input'
  | 'unknown-session'
  | 'spawn-failed'
  | 'write-failed'
  | 'timeout'
  | 'invalid-issues'
  | 'process-failed'
  | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface GrillMeError {
  kind: GrillMeErrorKind;
  /** The operation that failed, e.g. `startSession`. */
  operation: string;
  message: string;
}

/** The result of a grill-me command: either a value or a typed error. */
export type GrillMeResult<T> = { ok: true; value: T } | { ok: false; error: GrillMeError };

/**
 * An issue produced by the grill-me skill, as parsed from an `<ISSUES>` block.
 *
 * Mirrors the `Issue` entity in `CONTEXT.md`; `depends_on` holds the titles of
 * issues that must be implemented first.
 */
export interface GeneratedIssue {
  title: string;
  body: string;
  labels: string[];
  depends_on: string[];
}

/** Why a session ended. */
export type SessionEndReason = 'completed' | 'failed' | 'cancelled' | 'timeout';

/**
 * The events the module emits.
 *
 * `token` carries raw stream text for the live typing effect; the remaining
 * events carry the parsed structured output and lifecycle transitions.
 */
export interface GrillMeEventMap {
  token: { sessionId: string; text: string };
  question: { sessionId: string; question: string };
  plan_ready: { sessionId: string; plan: string };
  issues_generated: { sessionId: string; issues: GeneratedIssue[] };
  error: { sessionId: string; error: GrillMeError };
  ended: { sessionId: string; reason: SessionEndReason };
}

export type GrillMeEventName = keyof GrillMeEventMap;

export type GrillMeEventHandler<K extends GrillMeEventName> = (payload: GrillMeEventMap[K]) => void;

/**
 * Optional context for a one-shot {@link GrillMeModule.generateIssues} run.
 */
export interface GenerateIssuesOptions {
  /** Revision feedback to fold into the prompt, turning the run into a refine pass. */
  feedback?: string;
}

/**
 * The Grill-Me Module's public contract.
 *
 * Commands resolve to a {@link GrillMeResult}; output is delivered through
 * {@link GrillMeModule.on}. Callers subscribe, start a session, then drive it
 * with answers until the skill emits a plan and its issues.
 */
export interface GrillMeModule {
  /** Spawns an OpenCode session for `idea` and resolves the new session id. */
  startSession(
    projectId: string,
    idea: string,
    skillLevel: SkillLevel,
  ): Promise<GrillMeResult<string>>;
  /** Sends the Developer's answer to the current question. */
  submitAnswer(sessionId: string, answer: string): Promise<GrillMeResult<void>>;
  /** Sends feedback on the generated issues, prompting a revised `<ISSUES>` block. */
  refineIssues(sessionId: string, feedback: string): Promise<GrillMeResult<void>>;
  /** Ends the session and stops its process. */
  cancelSession(sessionId: string): Promise<GrillMeResult<void>>;
  /**
   * Runs a one-shot OpenCode pass over an existing plan and returns the issues
   * it emits, without holding a session open. Used to (re)generate a Project's
   * issues from its active plan; pass `feedback` to revise an existing list.
   */
  generateIssues(
    projectId: string,
    plan: string,
    skillLevel: SkillLevel,
    options?: GenerateIssuesOptions,
  ): Promise<GrillMeResult<GeneratedIssue[]>>;
  /** Subscribes to an event; returns a function that unsubscribes. */
  on<K extends GrillMeEventName>(event: K, handler: GrillMeEventHandler<K>): () => void;
}
