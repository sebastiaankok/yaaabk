import { fileURLToPath } from 'node:url';
import type { GitAuthor, TemplateSource } from './git-backend';

/** Port the scaffolded backend listens on when the project does not set one. */
export const DEFAULT_PORT = 3000;

/** Author recorded on the scaffold commit. */
export const DEFAULT_AUTHOR: GitAuthor = {
  name: 'YAAABK',
  email: 'yaaabk@users.noreply.github.com',
};

// A Project name is also its repository name, so the rule lives in `@yaaabk/shared`
// where the frontend can reuse it without pulling in this package's Node imports.
export { MAX_PROJECT_NAME_LENGTH, isValidProjectName } from '@yaaabk/shared';

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
