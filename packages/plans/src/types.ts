/**
 * Public domain types for the Plans Module.
 *
 * A Plan is a versioned markdown document produced by a Grill-Me Session. It
 * belongs to exactly one Project; the newest version is the active one unless
 * an earlier version is explicitly re-activated.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK: SQLite
 * stores them as TEXT and they sort lexicographically.
 */

import type { SkillLevel } from '@yaaabk/shared';

/** Where a Plan came from. */
export type PlanSource = 'grill-me' | 'upload';

/** A Plan as persisted and handed to the UI. */
export interface Plan {
  /** Stable internal id (uuid). */
  id: string;
  /** The Project this Plan belongs to. */
  projectId: string;
  /** 1-based version number, unique within a Project. */
  version: number;
  /** The plan document as Markdown. */
  contentMarkdown: string;
  /** The skill level in force when the plan was produced. */
  skillLevel: SkillLevel;
  source: PlanSource;
  createdAt: string;
  /** Whether this is the active version for its Project. */
  isActive: boolean;
}

/** The values needed to save a new Plan version. */
export interface NewPlan {
  projectId: string;
  contentMarkdown: string;
  skillLevel: SkillLevel;
  source: PlanSource;
}

/** The kinds of failure a Plans Module command can report. */
export type PlanErrorKind = 'invalid-input' | 'not-found' | 'duplicate-version' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface PlanError {
  kind: PlanErrorKind;
  /** The operation that failed, e.g. `create`. */
  operation: string;
  message: string;
}

/** The result of a Plans Module command: either a value or a typed error. */
export type PlansResult<T> = { ok: true; value: T } | { ok: false; error: PlanError };

/**
 * The persistence port the Plans Module is built on.
 *
 * Deliberately synchronous, matching the Projects and Auth Modules' stores:
 * the production adapter is `bun:sqlite`, which is synchronous, and so is the
 * fake.
 */
export interface PlanStore {
  /** Persists a new Plan. If it is active, deactivates earlier versions. */
  create(plan: Plan): void;
  /** Returns a Plan only when it belongs to the given Project. */
  get(projectId: string, planId: string): Plan | undefined;
  /** Every Plan for a Project, newest version first. */
  list(projectId: string): Plan[];
  /** The active Plan for a Project, if any. */
  getActive(projectId: string): Plan | undefined;
  /** The next version number for a Project. */
  nextVersion(projectId: string): number;
  /** Makes `planId` active and deactivates every other version. */
  activate(projectId: string, planId: string): void;
}

/** The Plans Module's public contract. */
export interface PlansModule {
  /** Saves a new version and marks it active. */
  create(input: NewPlan): Promise<PlansResult<Plan>>;
  /** Every version of a Project's Plan, newest first. */
  list(projectId: string): Promise<PlansResult<Plan[]>>;
  /** The active version, or `null` when the Project has none yet. */
  getActive(projectId: string): Promise<PlansResult<Plan | null>>;
  /** Re-activates an earlier version. */
  activate(projectId: string, planId: string): Promise<PlansResult<Plan>>;
}
