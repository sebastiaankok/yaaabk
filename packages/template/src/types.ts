/**
 * Public domain types for the Template Module.
 *
 * Failures never cross the module boundary as exceptions: `scaffold` resolves
 * to a {@link TemplateResult}, matching the K8s Client Module's contract.
 */

/** The kinds of failure a scaffold can report. */
export type TemplateErrorKind = 'invalid-project' | 'missing-template' | 'push-failed' | 'unknown';

/** A typed failure, never thrown across the module boundary. */
export interface TemplateError {
  kind: TemplateErrorKind;
  /** The operation that failed, e.g. `scaffold`. */
  operation: string;
  message: string;
}

/** The result of a scaffold: either a value or a typed error. */
export type TemplateResult<T> = { ok: true; value: T } | { ok: false; error: TemplateError };

/**
 * The project values a scaffold needs.
 *
 * A subset of the Project entity from `CONTEXT.md`: just the fields the
 * template interpolates.
 */
export interface TemplateProject {
  /** Stable internal id (uuid). The K8s namespace is derived from it. */
  id: string;
  /** GitHub repository and project name, e.g. `todo-app`. */
  name: string;
  /** Git URL the scaffolded repository is pushed to. */
  repoUrl: string;
  /** Port the scaffolded backend listens on. Defaults to 3000. */
  port?: number;
  /** ArgoCD Application name. Defaults to the project name. */
  argoAppName?: string;
  /** Branch the scaffold is pushed to. Defaults to `main`. */
  branch?: string;
}

/** What a successful scaffold produced. */
export interface ScaffoldResult {
  name: string;
  repoUrl: string;
  branch: string;
  /** Absolute path to the working copy. The caller owns cleanup. */
  directory: string;
  /** Files written, relative to `directory`, sorted. */
  files: string[];
}

/** The Template Module's public contract. */
export interface TemplateModule {
  scaffold(project: TemplateProject): Promise<TemplateResult<ScaffoldResult>>;
}
