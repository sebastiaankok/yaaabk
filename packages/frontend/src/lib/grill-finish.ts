/** What the backend says Finish is missing, as the API client carries it. */
export type FinishMissing = readonly string[];

/**
 * Whether a forced publish can succeed.
 *
 * A Plan cannot exist without a PRD, so "Publish anyway" is only meaningful
 * when the Issue list is the single missing draft. Offering it for a missing
 * PRD dead-ends on the same 409 the Developer just saw.
 */
export function canForceFinish(missing: FinishMissing): boolean {
  return missing.length === 1 && missing[0] === 'issues';
}

/** What the Developer should do next when Finish refuses a session. */
export function finishHint(missing: FinishMissing): string | null {
  if (missing.includes('prd')) {
    return 'The PRD has not been drafted yet. Ask the agent in the terminal to write it, then click Finish again, or cancel the session.';
  }
  if (missing.includes('issues')) {
    return 'The PRD is drafted but the Issue list is missing. Publish anyway finishes the session with the PRD only.';
  }
  return null;
}
