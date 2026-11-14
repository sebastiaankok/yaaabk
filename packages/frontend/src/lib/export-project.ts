import { MAX_PROJECT_NAME_LENGTH, isValidProjectName } from '@yaaabk/shared';

/**
 * The target a Developer types into the export form: their GitHub username and
 * optionally a new repository name. Validation mirrors the backend's rules so
 * mistakes are caught inline rather than after a round-trip.
 */
export interface ExportTarget {
  owner: string;
  /** Empty means keep the Project name. */
  repoName: string;
}

/** Field-level failures for the export form. Absent keys are valid. */
export interface ExportTargetErrors {
  owner?: string;
  repoName?: string;
}

/** Whether any field of `errors` is set. */
export function hasErrors(errors: ExportTargetErrors): boolean {
  return errors.owner !== undefined || errors.repoName !== undefined;
}

/** Validates the export target, returning a message per invalid field. */
export function validateExportTarget(target: ExportTarget): ExportTargetErrors {
  const errors: ExportTargetErrors = {};

  const owner = target.owner.trim();
  if (owner === '') {
    errors.owner = 'A GitHub username is required';
  } else if (!isValidProjectName(owner)) {
    errors.owner = `Use lowercase letters, digits and single hyphens, starting with a letter (max ${MAX_PROJECT_NAME_LENGTH} characters)`;
  }

  const repoName = target.repoName.trim();
  if (repoName !== '' && !isValidProjectName(repoName)) {
    errors.repoName = `Use lowercase letters, digits and single hyphens, starting with a letter (max ${MAX_PROJECT_NAME_LENGTH} characters)`;
  }

  return errors;
}
