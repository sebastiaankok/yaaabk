import { fileURLToPath } from 'node:url';
import type { GitAuthor, TemplateSource } from './git-backend';

/** Port the scaffolded backend listens on when the project does not set one. */
export const DEFAULT_PORT = 3000;

/** Author recorded on the scaffold commit. */
export const DEFAULT_AUTHOR: GitAuthor = {
  name: 'YAAABK',
  email: 'yaaabk@users.noreply.github.com',
};

/** GitHub-friendly slug: lowercase, hyphen-separated, starting with a letter. */
const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Keeps names within npm's package-name limit so the template can publish one. */
const MAX_PROJECT_NAME_LENGTH = 39;

/** Whether `name` is a valid Project name (and therefore a valid repo name). */
export function isValidProjectName(name: string): boolean {
  return name.length <= MAX_PROJECT_NAME_LENGTH && PROJECT_NAME_PATTERN.test(name);
}

/** Whether `url` looks like a git remote we can push to. */
export function isValidRepoUrl(url: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@)[^\s]+$/.test(url.trim());
}

/**
 * The template the module scaffolds by default: the in-repo
 * `templates/svelte-bun`. `YAAABK_TEMPLATE_DIR` overrides it, which lets a
 * deployment point at a mounted copy instead.
 */
export function defaultTemplateSource(): TemplateSource {
  const override = process.env['YAAABK_TEMPLATE_DIR'];
  if (override !== undefined && override !== '') {
    return { type: 'directory', path: override };
  }
  return {
    type: 'directory',
    path: fileURLToPath(new URL('../../../templates/svelte-bun', import.meta.url)),
  };
}
