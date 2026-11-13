/** The skill levels a Developer can choose; controls grill-me prompt depth. */
export const SKILL_LEVELS = ['beginner', 'expert'] as const;

export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** Narrows an unknown value (e.g. user input) to a {@link SkillLevel}. */
export function isSkillLevel(value: unknown): value is SkillLevel {
  return typeof value === 'string' && (SKILL_LEVELS as readonly string[]).includes(value);
}
