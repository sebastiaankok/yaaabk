/**
 * The YAAABK-only metadata that rides along in a GitHub Issue body.
 *
 * A GitHub Issue is the mirror of a local Issue, but a few fields are YAAABK's
 * alone: the dependency titles an Issue waits on and its per-Issue OpenRouter
 * budget. GitHub has nowhere to put them, so they are tucked into an HTML
 * comment footer. A comment is invisible when GitHub renders the issue, yet
 * survives every round trip, so `pull` can restore what `push` wrote.
 */

/** The fields YAAABK keeps for itself inside a GitHub Issue body. */
export interface IssueMetadata {
  dependsOn: string[];
  budgetCents: number;
}

const FOOTER = /<!--\s*yaaabk:meta\s*([\s\S]*?)\s*-->/;

function trimTrailingBlankLines(text: string): string {
  return text.replace(/[\s\uFEFF\xA0]+$/, '');
}

/** Appends the YAAABK footer to a body. An empty body becomes just the footer. */
export function encodeIssueBody(body: string, metadata: IssueMetadata): string {
  const json = JSON.stringify({
    depends_on: metadata.dependsOn,
    budget_cents: metadata.budgetCents,
  });
  const footer = `<!-- yaaabk:meta ${json} -->`;
  const trimmed = trimTrailingBlankLines(body);
  return trimmed === '' ? footer : `${trimmed}\n\n${footer}`;
}

/**
 * Splits a body back into the human-readable text and the YAAABK metadata.
 *
 * A missing, malformed or empty footer yields `metadata: null`; a footer that
 * is present but unreadable is still stripped so it never leaks into the UI.
 */
export function decodeIssueBody(body: string): { body: string; metadata: IssueMetadata | null } {
  const match = FOOTER.exec(body);
  if (match === null) {
    return { body, metadata: null };
  }

  const stripped = trimTrailingBlankLines(body.replace(match[0], ''));
  const raw = match[1];
  if (raw === undefined) {
    return { body: stripped, metadata: null };
  }

  try {
    const parsed = JSON.parse(raw) as { depends_on?: unknown; budget_cents?: unknown };
    const dependsOn = parsed.depends_on;
    const budgetCents = parsed.budget_cents;
    const validDeps =
      Array.isArray(dependsOn) && dependsOn.every((item) => typeof item === 'string');
    const validBudget = typeof budgetCents === 'number' && Number.isInteger(budgetCents);
    if (!validDeps || !validBudget) {
      return { body: stripped, metadata: null };
    }
    return { body: stripped, metadata: { dependsOn: [...dependsOn], budgetCents } };
  } catch {
    return { body: stripped, metadata: null };
  }
}
