/**
 * Where a scaffolded project's template is copied from.
 *
 * A `directory` source is read straight off disk (the in-repo
 * `templates/svelte-bun`); a `git` source is cloned. Which one is used is a
 * deployment concern, so the module treats both the same.
 */
export type TemplateSource =
  { type: 'directory'; path: string } | { type: 'git'; url: string; ref?: string };

/** Identifies the author recorded on the scaffold commit. */
export interface GitAuthor {
  name: string;
  email: string;
}

/**
 * The low-level port the Template Module is built on.
 *
 * It is intentionally narrow (four verbs) and git-shaped: the high-level module
 * holds all the YAAABK-specific logic (validation, interpolation, ordering)
 * while the adapter holds every `git` invocation. Tests inject
 * {@link createFakeGitBackend} instead of shelling out.
 */
export interface GitBackend {
  /** Materialises the template into `directory`, which must exist and be empty. */
  fetchTemplate(source: TemplateSource, directory: string): Promise<void>;
  /**
   * Discards any history the template carried (e.g. a clone's `.git`) and
   * initialises a fresh repository at `directory`.
   */
  initRepository(directory: string): Promise<void>;
  /** Stages every file and records a single commit. */
  commitAll(directory: string, options: { message: string; author: GitAuthor }): Promise<void>;
  /** Points `origin` at `url` and pushes `branch`. */
  push(directory: string, options: { url: string; branch: string }): Promise<void>;
}
