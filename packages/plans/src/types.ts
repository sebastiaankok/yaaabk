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
  /** A one- or two-sentence plain-text summary; null only for rows from before summaries. */
  summary: string | null;
  /** The skill level in force when the plan was produced. */
  skillLevel: SkillLevel;
  source: PlanSource;
  createdAt: string;
  /** Whether this is the active version for its Project. */
  isActive: boolean;
  /**
   * When the Developer accepted the Plan, recording it and its Issues on
   * GitHub. `null` until accepted; set only after the GitHub push succeeds.
   */
  acceptedAt: string | null;
}

/** One of a Plan's Issues, as the dependency graph places it. */
export interface PlanAcceptanceIssue {
  title: string;
  /** 0-based wave, or `null` when the Issue sits on a cycle. */
  wave: number | null;
  /** Dependency titles that match no Issue in the graph. */
  missing: string[];
}

/** What the acceptance check needs to know about a Plan's Issues. */
export interface PlanAcceptanceFacts {
  /** How many Issues the Plan owns, closed ones included. */
  issueCount: number;
  /** Where each of those Issues sits in the Project's dependency graph. */
  issues: PlanAcceptanceIssue[];
}

/** The result of syncing a Plan's Issues to GitHub during acceptance. */
export type PlanAcceptPush = { ok: true } | { ok: false; message: string };

/** The facts and side effects `accept` needs from its caller. */
export interface PlanAcceptance {
  facts: PlanAcceptanceFacts;
  /** Syncs only this Plan's Issues to GitHub. Runs after the checks pass. */
  push(): Promise<PlanAcceptPush>;
}

/** The values needed to save a new Plan version. */
export interface NewPlan {
  projectId: string;
  contentMarkdown: string;
  /**
   * A plain-text summary. Omit or pass null to derive a fallback from the
   * Markdown; a supplied summary must be non-empty and at most 200 characters.
   */
  summary?: string | null;
  skillLevel: SkillLevel;
  source: PlanSource;
}

/** The kinds of failure a Plans Module command can report. */
export type PlanErrorKind =
  | 'invalid-input'
  | 'not-found'
  | 'duplicate-version'
  | 'not-acceptable'
  | 'sync-failed'
  | 'unknown';

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
  /** Records when a Plan was accepted. Throws when the Plan does not exist. */
  accept(projectId: string, planId: string, acceptedAt: string): void;
  /** Removes every Plan in a Project, for when the Project itself is deleted. */
  deleteForProject(projectId: string): void;
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
  /**
   * Accepts the active, unaccepted Plan: validates its Issues, syncs only them
   * to GitHub, then records the acceptance. A failed push leaves the Plan
   * unaccepted so the Developer can retry.
   */
  accept(projectId: string, planId: string, acceptance: PlanAcceptance): Promise<PlansResult<Plan>>;
  /** Removes every Plan in a Project, for when the Project itself is deleted. */
  removeForProject(projectId: string): Promise<PlansResult<void>>;
}
