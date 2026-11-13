import {
  MAX_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  isValidProjectName,
} from '@yaaabk/shared';

/**
 * The details a Developer types on the first wizard step, before a Project
 * exists. Validation mirrors the backend's rules so mistakes are caught inline
 * rather than after a round-trip.
 */
export interface ProjectDetails {
  name: string;
  description: string;
}

/** Field-level failures for the details step. Absent keys are valid. */
export interface ProjectDetailsErrors {
  name?: string;
  description?: string;
}

/** Whether any field of `errors` is set. */
export function hasErrors(errors: ProjectDetailsErrors): boolean {
  return errors.name !== undefined || errors.description !== undefined;
}

/** Validates the details step, returning a message per invalid field. */
export function validateProjectDetails(details: ProjectDetails): ProjectDetailsErrors {
  const errors: ProjectDetailsErrors = {};

  const name = details.name.trim();
  if (name === '') {
    errors.name = 'A project name is required';
  } else if (!isValidProjectName(name)) {
    errors.name = `Use lowercase letters, digits and single hyphens, starting with a letter (max ${MAX_PROJECT_NAME_LENGTH} characters)`;
  }

  const description = details.description.trim();
  if (description === '') {
    errors.description = 'A description is required';
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  return errors;
}
