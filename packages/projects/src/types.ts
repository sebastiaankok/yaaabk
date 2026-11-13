/**
 * Public domain types for the Projects Module.
 *
 * A Project is a Developer's software project, backed 1:1 by a GitHub (or, in
 * future, GitLab) repository and a Kubernetes namespace. Creating a Project
 * provisions both: a repository scaffolded from the YAAABK template, and a
 * namespace hosting the Project's application and agent infrastructure.
 *
 * Timestamps are ISO-8601 UTC strings, matching the rest of YAAABK: SQLite
 * stores them as TEXT and they sort lexicographically.
 */

import type { SkillLevel } from '@yaaabk/shared';

/** A Project as persisted and handed to the UI. */
export interface Project {
  /** Stable internal id (uuid). The namespace is derived from it. */
  id: string;
  /** GitHub repository and project name, e.g. `todo-app`. Immutable. */
  name: string;
  description: string;
  skillLevel: SkillLevel;
  /** HTTPS URL of the backing repository, for the UI. */
  repoUrl: string;
  /** Full repository name, e.g. `acme/todo-app`. */
  repoFullName: string;
  /** Kubernetes namespace hosting the Project, `project-<short-uuid>`. */
  namespace: string;
  /** ArgoCD Application name. */
  argoAppName: string;
  createdAt: string;
  updatedAt: string;
}

/** The values needed to create a Project. */
export interface NewProject {
  name: string;
  description: string;
  skillLevel: SkillLevel;
}

/**
 * The fields of a Project a Developer may change.
 *
 * `name` is absent: it is the repository and namespace identity, so it is fixed
 * for a Project's lifetime.
 */
export interface ProjectPatch {
  description?: string;
  skillLevel?: SkillLevel;
}

/** The kinds of failure a Projects Module command can report. */
export type ProjectErrorKind =
  | 'invalid-input'
  | 'duplicate-name'
  | 'not-found'
  | 'repository'
  | 'scaffold'
  | 'kubernetes'
  | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface ProjectError {
  kind: ProjectErrorKind;
  /** The operation that failed, e.g. `create`. */
  operation: string;
  message: string;
}

/** The result of a Projects Module command: either a value or a typed error. */
export type ProjectsResult<T> = { ok: true; value: T } | { ok: false; error: ProjectError };

/**
 * The provisioning steps `create` walks through, in order.
 *
 * `persist` is last: nothing is written to the store until every external
 * resource exists, so a failed creation never leaves a half-registered Project.
 */
export type ProvisioningStep =
  | 'repository'
  | 'scaffold'
  | 'namespace'
  | 'service-account'
  | 'role-binding'
  | 'secret'
  | 'argocd'
  | 'persist';

/**
 * A step lifecycle event, emitted so the UI can show creation progress.
 *
 * A step emits `started` immediately before it runs and `completed` after it
 * succeeds; a failing step emits `started` but never `completed`.
 */
export interface ProvisioningEvent {
  step: ProvisioningStep;
  status: 'started' | 'completed';
}

export interface CreateProjectOptions {
  /** Observes provisioning progress. Called synchronously as each step runs. */
  onProgress?: (event: ProvisioningEvent) => void;
}

/** The Projects Module's public contract. */
export interface ProjectsModule {
  /** Provisions the repository and cluster resources, then records the Project. */
  create(input: NewProject, options?: CreateProjectOptions): Promise<ProjectsResult<Project>>;
  /** Every Project, newest first. */
  list(): Promise<ProjectsResult<Project[]>>;
  get(id: string): Promise<ProjectsResult<Project>>;
  /** Updates the mutable metadata of a Project. */
  update(id: string, patch: ProjectPatch): Promise<ProjectsResult<Project>>;
  /** Tears down the Project's repository and cluster resources, then forgets it. */
  remove(id: string): Promise<ProjectsResult<void>>;
}

/**
 * The persistence port the Projects Module is built on.
 *
 * Deliberately synchronous, matching the Auth Module's `AuthStore`: the
 * production adapter is `bun:sqlite`, which is synchronous, and so is the fake.
 */
export interface ProjectStore {
  /** Persists a new Project. Throws a duplicate-name error on a clash. */
  create(project: Project): void;
  get(id: string): Project | undefined;
  getByName(name: string): Project | undefined;
  /** Every Project, newest first. */
  list(): Project[];
  update(project: Project): void;
  delete(id: string): void;
}
