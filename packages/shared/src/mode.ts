/** How a Project's agent works with the Developer. */
export const PROJECT_MODES = ['autonomous', 'guided'] as const;

export type ProjectMode = (typeof PROJECT_MODES)[number];

/** Narrows an unknown value (e.g. user input) to a {@link ProjectMode}. */
export function isProjectMode(value: unknown): value is ProjectMode {
  return typeof value === 'string' && (PROJECT_MODES as readonly string[]).includes(value);
}
