/**
 * Shared rules for Plan and Issue summaries.
 *
 * A summary is one or two plain sentences the Developer reads in lists and
 * disclosures. It is YAAABK-only UI data: it never becomes part of a GitHub
 * Issue body. Both the session reporting tools and the domain modules validate
 * it here so a summary has one length and one shape everywhere.
 */

/** The longest summary a Plan or Issue may carry, in characters. */
export const SUMMARY_MAX_LENGTH = 200;

/** The outcome of validating a summary the caller supplied. */
export type SummaryResult = { ok: true; value: string } | { ok: false; message: string };

/** Trims, collapses whitespace and checks a summary's length. */
export function normaliseSummary(value: unknown): SummaryResult {
  if (typeof value !== 'string') {
    return { ok: false, message: 'A summary is required' };
  }
  const summary = value.trim().replace(/\s+/g, ' ');
  if (summary === '') {
    return { ok: false, message: 'A summary is required' };
  }
  if (summary.length > SUMMARY_MAX_LENGTH) {
    return {
      ok: false,
      message: `The summary must be at most ${SUMMARY_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, value: summary };
}

/** Removes the inline Markdown that would read as punctuation in a summary. */
function plainText(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^(?:[-*+]|\d+\.)\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '');
}

/** Cuts a long summary back to a whole word and marks the cut. */
function truncate(summary: string): string {
  if (summary.length <= SUMMARY_MAX_LENGTH) return summary;
  const room = SUMMARY_MAX_LENGTH - 1;
  const clipped = summary.slice(0, room);
  const boundary = clipped.lastIndexOf(' ');
  const stem = boundary > 0 ? clipped.slice(0, boundary) : clipped;
  return `${stem.trimEnd()}…`;
}

/**
 * Derives a fallback summary from the first paragraph of Markdown.
 *
 * Older rows and manual uploads may have no summary. The first non-empty block
 * is the best short description such a document offers. Returns `''` when the
 * Markdown has no text at all, so callers can decide what to show.
 */
export function deriveSummary(markdown: string): string {
  const firstParagraph = markdown
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !/^#{1,6}\s+/.test(line.trim()))
        .join('\n')
        .trim(),
    )
    .find((block) => block !== '');
  if (firstParagraph === undefined) {
    const heading = markdown.trim().split('\n')[0] ?? '';
    return truncate(plainText(heading.trim()).replace(/\s+/g, ' ').trim());
  }

  const summary = firstParagraph
    .split('\n')
    .map((line) => plainText(line.trim()))
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(summary);
}
