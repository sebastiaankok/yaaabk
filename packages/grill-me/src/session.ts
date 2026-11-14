import { randomUUID } from 'node:crypto';
import { isSkillLevel } from '@yaaabk/shared';
import {
  DEFAULT_SESSION_TIMEOUT_MS,
  buildIssuesPrompt,
  buildRefineMessage,
  buildSessionPrompt,
  defaultSkillPath,
} from './config';
import {
  consoleLogger,
  grillMeError,
  messageOf,
  toGrillMeError,
  type GrillMeLogger,
} from './errors';
import { parseGeneratedIssues } from './issues';
import { createMarkerParser, type MarkerParser, type ParsedChunk } from './markers';
import { createOpenCodeSpawner } from './opencode-process';
import type { OpenCodeProcess, OpenCodeProcessExit, OpenCodeSpawner } from './process';
import type {
  GeneratedIssue,
  GrillMeError,
  GrillMeEventMap,
  GrillMeEventName,
  GrillMeModule,
  GrillMeResult,
  SessionEndReason,
} from './types';

export interface GrillMeModuleOptions {
  /**
   * Low-level port the module is built on. Tests inject
   * {@link createFakeSpawner}; when omitted the module spawns the real
   * `opencode` CLI.
   */
  spawner?: OpenCodeSpawner;
  /** Session timeout. Defaults to {@link DEFAULT_SESSION_TIMEOUT_MS} (30 minutes). */
  timeoutMs?: number;
  /** Path to the grill-me skill. Defaults to the in-repo `skills/grill-me`. */
  skillPath?: string;
  logger?: GrillMeLogger;
}

interface Session {
  id: string;
  process: OpenCodeProcess;
  parser: MarkerParser;
  ended: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Builds the public Grill-Me Module. */
export function createGrillMeModule(options: GrillMeModuleOptions = {}): GrillMeModule {
  const logger = options.logger ?? consoleLogger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const skillPath = options.skillPath ?? defaultSkillPath();
  let spawner = options.spawner;

  const sessions = new Map<string, Session>();
  const handlers = new Map<GrillMeEventName, Set<(payload: unknown) => void>>();

  function spawnerOf(): OpenCodeSpawner {
    if (spawner === undefined) {
      spawner = createOpenCodeSpawner({ logger });
    }
    return spawner;
  }

  function emit<K extends GrillMeEventName>(event: K, payload: GrillMeEventMap[K]): void {
    const subscribers = handlers.get(event);
    if (subscribers === undefined) {
      return;
    }
    for (const handler of subscribers) {
      try {
        handler(payload);
      } catch (error) {
        logger.error('grill-me event handler failed', { event, message: messageOf(error) });
      }
    }
  }

  function handleParsed(sessionId: string, parsed: ParsedChunk): void {
    if (parsed.kind === 'token') {
      if (parsed.text !== '') {
        emit('token', { sessionId, text: parsed.text });
      }
      return;
    }
    if (parsed.type === 'QUESTION') {
      emit('question', { sessionId, question: parsed.content.trim() });
      return;
    }
    if (parsed.type === 'PLAN') {
      emit('plan_ready', { sessionId, plan: parsed.content.trim() });
      return;
    }
    try {
      emit('issues_generated', { sessionId, issues: parseGeneratedIssues(parsed.content) });
    } catch (error) {
      const mapped = toGrillMeError('parseIssues', error);
      logger.error('grill-me parseIssues failed', { sessionId, kind: mapped.kind });
      emit('error', { sessionId, error: mapped });
    }
  }

  function handleOutput(session: Session, chunk: string): void {
    for (const parsed of session.parser.push(chunk)) {
      handleParsed(session.id, parsed);
    }
  }

  function endSession(session: Session, reason: SessionEndReason): void {
    if (session.ended) {
      return;
    }
    // Flush first, so a final block that arrived without a trailing newline is
    // still reported before the session is declared over.
    for (const parsed of session.parser.flush()) {
      handleParsed(session.id, parsed);
    }
    session.ended = true;
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
    }
    sessions.delete(session.id);
    logger.info('grill-me session ended', { sessionId: session.id, reason });
    emit('ended', { sessionId: session.id, reason });
  }

  function handleExit(session: Session, exit: OpenCodeProcessExit): void {
    if (session.ended) {
      return;
    }
    if (exit.code !== 0) {
      const error: GrillMeError = {
        kind: 'process-failed',
        operation: 'process',
        message: `The OpenCode process exited with code ${exit.code ?? 'null'}`,
      };
      logger.error('grill-me process failed', { sessionId: session.id, code: exit.code });
      emit('error', { sessionId: session.id, error });
      endSession(session, 'failed');
      return;
    }
    endSession(session, 'completed');
  }

  function requireActive(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw grillMeError('unknown-session', `No active grill-me session "${sessionId}"`);
    }
    return session;
  }

  /**
   * Runs a command, mapping failures to typed errors and logging every attempt.
   */
  async function guard<T>(
    operation: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<GrillMeResult<T>> {
    try {
      const value = await run();
      logger.info(`grill-me ${operation}`, fields);
      return { ok: true, value };
    } catch (error) {
      const mapped = toGrillMeError(operation, error);
      logger.error(`grill-me ${operation} failed`, { ...fields, kind: mapped.kind });
      return { ok: false, error: mapped };
    }
  }

  async function writeToProcess(session: Session, message: string): Promise<void> {
    try {
      await session.process.send(message);
    } catch (error) {
      throw grillMeError('write-failed', 'Could not write to the OpenCode process', error);
    }
  }

  return {
    async startSession(projectId, idea, skillLevel) {
      return guard('startSession', { projectId, skillLevel }, async () => {
        if (typeof projectId !== 'string' || projectId.trim() === '') {
          throw grillMeError('invalid-input', 'A project id is required');
        }
        if (typeof idea !== 'string' || idea.trim() === '') {
          throw grillMeError('invalid-input', 'An idea is required');
        }
        if (!isSkillLevel(skillLevel)) {
          throw grillMeError('invalid-input', `"${String(skillLevel)}" is not a valid skill level`);
        }

        const sessionId = randomUUID();
        // The spawner's callbacks are wired before the session object exists, so
        // they read it through a ref that is filled in once `spawn` resolves.
        const ref: { current?: Session } = {};

        const child = await spawnerOf()
          .spawn({
            sessionId,
            projectId,
            idea,
            skillLevel,
            skillPath,
            prompt: buildSessionPrompt({ projectId, idea, skillLevel, skillPath }),
            onOutput: (chunk) => {
              if (ref.current !== undefined) {
                handleOutput(ref.current, chunk);
              }
            },
            onError: (chunk) => {
              logger.error('grill-me process stderr', { sessionId, message: chunk.trim() });
            },
          })
          .catch((error: unknown) => {
            throw grillMeError('spawn-failed', 'Could not start the OpenCode session', error);
          });

        const session: Session = {
          id: sessionId,
          process: child,
          parser: createMarkerParser(),
          ended: false,
        };
        ref.current = session;
        sessions.set(sessionId, session);

        session.timer = setTimeout(() => {
          if (session.ended) {
            return;
          }
          const error: GrillMeError = {
            kind: 'timeout',
            operation: 'session',
            message: `The grill-me session exceeded ${timeoutMs} ms`,
          };
          logger.error('grill-me session timed out', { sessionId });
          emit('error', { sessionId, error });
          endSession(session, 'timeout');
          void child.stop();
        }, timeoutMs);

        void child.exited.then((exit) => handleExit(session, exit));

        return sessionId;
      });
    },

    async submitAnswer(sessionId, answer) {
      return guard('submitAnswer', { sessionId }, async () => {
        const session = requireActive(sessionId);
        if (typeof answer !== 'string' || answer.trim() === '') {
          throw grillMeError('invalid-input', 'An answer is required');
        }
        await writeToProcess(session, answer);
      });
    },

    async refineIssues(sessionId, feedback) {
      return guard('refineIssues', { sessionId }, async () => {
        const session = requireActive(sessionId);
        if (typeof feedback !== 'string' || feedback.trim() === '') {
          throw grillMeError('invalid-input', 'Refinement feedback is required');
        }
        await writeToProcess(session, buildRefineMessage(feedback));
      });
    },

    async cancelSession(sessionId) {
      return guard('cancelSession', { sessionId }, async () => {
        const session = requireActive(sessionId);
        endSession(session, 'cancelled');
        await session.process.stop();
      });
    },

    async generateIssues(projectId, plan, skillLevel, options = {}) {
      return guard('generateIssues', { projectId, skillLevel }, async () => {
        if (typeof projectId !== 'string' || projectId.trim() === '') {
          throw grillMeError('invalid-input', 'A project id is required');
        }
        if (typeof plan !== 'string' || plan.trim() === '') {
          throw grillMeError('invalid-input', 'A plan is required');
        }
        if (!isSkillLevel(skillLevel)) {
          throw grillMeError('invalid-input', `"${String(skillLevel)}" is not a valid skill level`);
        }

        const sessionId = randomUUID();
        const parser = createMarkerParser();
        // The spawner's `onOutput` is wired before the promise below exists, so
        // it reaches the handler through a ref filled in once the spawn resolves.
        const handler: { current?: (parsed: ParsedChunk) => void } = {};

        const child = await spawnerOf()
          .spawn({
            sessionId,
            projectId,
            idea: plan,
            skillLevel,
            skillPath,
            prompt: buildIssuesPrompt({
              projectId,
              plan,
              skillLevel,
              skillPath,
              ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
            }),
            onOutput: (chunk) => {
              for (const parsed of parser.push(chunk)) {
                handler.current?.(parsed);
              }
            },
            onError: (chunk) => {
              logger.error('grill-me process stderr', { sessionId, message: chunk.trim() });
            },
          })
          .catch((error: unknown) => {
            throw grillMeError('spawn-failed', 'Could not start the OpenCode session', error);
          });

        return await new Promise<GeneratedIssue[]>((resolve, reject) => {
          let settled = false;
          const deadline: { timer?: ReturnType<typeof setTimeout> } = {};

          function finish(settle: () => void): void {
            if (settled) {
              return;
            }
            settled = true;
            if (deadline.timer !== undefined) {
              clearTimeout(deadline.timer);
            }
            settle();
          }

          function onParsed(parsed: ParsedChunk): void {
            if (parsed.kind !== 'block' || parsed.type !== 'ISSUES') {
              return;
            }
            try {
              const issues = parseGeneratedIssues(parsed.content);
              finish(() => {
                void child.stop();
                resolve(issues);
              });
            } catch (error) {
              finish(() => {
                void child.stop();
                reject(grillMeError('invalid-issues', messageOf(error), error));
              });
            }
          }

          handler.current = onParsed;

          deadline.timer = setTimeout(() => {
            finish(() => {
              void child.stop();
              reject(grillMeError('timeout', `The issue generation exceeded ${timeoutMs} ms`));
            });
          }, timeoutMs);
          void child.exited.then((exit) => {
            for (const parsed of parser.flush()) {
              onParsed(parsed);
            }
            finish(() => {
              reject(
                exit.code !== 0
                  ? grillMeError(
                      'process-failed',
                      `The OpenCode process exited with code ${exit.code ?? 'null'}`,
                    )
                  : grillMeError('invalid-issues', 'The agent produced no issues'),
              );
            });
          });
        });
      });
    },

    on(event, handler) {
      let subscribers = handlers.get(event);
      if (subscribers === undefined) {
        subscribers = new Set();
        handlers.set(event, subscribers);
      }
      const entry = handler as unknown as (payload: unknown) => void;
      subscribers.add(entry);
      return () => {
        subscribers.delete(entry);
      };
    },
  };
}
