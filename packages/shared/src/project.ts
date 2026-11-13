/**
 * Project field constraints, shared by the backend (which provisions the
 * repository and namespace) and the frontend (which validates the wizard form).
 *
 * A Project name is also its GitHub repository name, so it must be a
 * GitHub-friendly slug.
 */

/** Keeps names within npm's package-name limit so the template can publish one. */
export const MAX_PROJECT_NAME_LENGTH = 39;

/** Longest Project description the platform accepts. */
export const MAX_DESCRIPTION_LENGTH = 500;

/** GitHub-friendly slug: lowercase, hyphen-separated, starting with a letter. */
const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Whether `name` is a valid Project name (and therefore a valid repo name). */
export function isValidProjectName(name: string): boolean {
  return name.length <= MAX_PROJECT_NAME_LENGTH && PROJECT_NAME_PATTERN.test(name);
}
