/**
 * The persistence port for Grill-Me Sessions.
 *
 * The orchestrator keeps a session record (status, runtime reference, credential
 * hashes, drafts) so a backend restart can re-adopt live runtimes and reap the
 * credentials of sessions that ended. Tests use the in-memory store; the backend
 * uses the SQLite adapter.
 */

import type { GrillSessionRecord } from './session';

/** Persistence for session records. Synchronous, matching the other stores. */
export interface GrillSessionStore {
  /** Inserts or replaces the record for its id. */
  save(session: GrillSessionRecord): void;
  /** One record, including ended sessions. */
  get(sessionId: string): GrillSessionRecord | undefined;
  /** Every record, in insertion order. */
  list(): GrillSessionRecord[];
}

/** A dependency-free store for tests and in-process use. */
export function createInMemoryGrillSessionStore(): GrillSessionStore {
  const sessions = new Map<string, GrillSessionRecord>();

  return {
    save(session) {
      sessions.set(session.id, structuredClone(session));
    },

    get(sessionId) {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : structuredClone(session);
    },

    list() {
      return [...sessions.values()].map((session) => structuredClone(session));
    },
  };
}
