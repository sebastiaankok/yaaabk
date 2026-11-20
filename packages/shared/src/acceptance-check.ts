/**
 * The executable-acceptance-check policy from ADR 0002.
 *
 * A `ready` Issue promises work an Agent can finish and verify on its own. The
 * Agent model is text-only and the Agent image has no browser, so a check that
 * asks someone to look at the page is not verifiable. A `ready` body must name
 * a command and its expected result; a visual-only check belongs in
 * `needs-human`.
 *
 * The policy is deliberately narrow: it only reads the `ready` label and looks
 * for a command plus an expected result inside an acceptance section.
 */

/** A check as it appears in an Issue body. */
export interface AcceptanceCheck {
  text: string;
  /** Names a command and an expected result. */
  executable: boolean;
  /** Needs a person to look at the page. */
  visualOnly: boolean;
}

/** The verdict for one Issue body. */
export interface AcceptanceReview {
  /** At least one check names a command and an expected result. */
  executable: boolean;
  /** Checks that need a person to look at the page. */
  visualOnly: string[];
  /** Whether the body may back a `ready` Issue. */
  ok: boolean;
  checks: AcceptanceCheck[];
}

/** Command names and script paths that count as runnable. */
const COMMAND = new RegExp(
  [
    '\\b(?:bun|node|deno|npm|npx|pnpm|yarn|pytest|python3?|go|cargo|make|mvn|gradlew?|dotnet|rspec|phpunit|playwright|cypress|vitest|jest|curl|kubectl|docker|bash|sh|tsc|eslint|prettier|svelte-check|just|turbo|task)\\b',
    '(?:^|\\s)\\.?/?(?:scripts|bin)/[\\w./-]+',
  ].join('|'),
  'i',
);

/** Words that state the expected result of running a command. */
const EXPECTED_RESULT = new RegExp(
  [
    '\\b(?:expect(?:ed|s)?|should|must|passes?|passing|fails?|failing|returns?|printed|prints?|outputs?|succeeds?|reports?|matches?|equals?|contains?|renders?|status\\s+\\d{3}|\\d{3}\\s+(?:ok|created|no content|bad request|unauthorized|not found))\\b',
    '\\bexits?\\s+(?:0|non-zero)\\b',
    '\\b(?:all|the)\\s+tests?\\s+(?:pass|fail)\\b',
  ].join('|'),
  'i',
);

/** Verbs that ask a person to judge what they see. */
const HUMAN_JUDGEMENT =
  /\b(?:confirm|verify|check|ensure|inspect|look at|read|view|open|tab through|click through|scan|compare)\b/i;

/** What a person judges by looking. */
const VISUAL_SUBJECT =
  /\b(?:visually|visual|appearance|looks?(?:\s+right)?|centr(?:ed|es|ing)|align(?:ed|ment)?|spacing|padding|margin|contrast|readab(?:le|ility)|reads clearly|focus ring|light mode|dark mode|screenshots?|viewport|by eye|pixels?|appears?|shows?|displays?|visible)\b/i;

/** Headings whose section holds the checks. */
const ACCEPTANCE_HEADING =
  /^(?:acceptance criteria|acceptance checks|how to test|testing decisions|verification|definition of done)$/i;

/** One heading in a Markdown body. */
interface Heading {
  level: number;
  text: string;
  index: number;
}

function headings(lines: readonly string[]): Heading[] {
  const found: Heading[] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match !== null) {
      found.push({ level: match[1]?.length ?? 1, text: match[2] ?? '', index });
    }
  }
  return found;
}

/** The lines between the first acceptance heading and the next heading above it. */
function acceptanceSection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const seen = headings(lines);
  const start = seen.findIndex((heading) => ACCEPTANCE_HEADING.test(heading.text));
  if (start === -1) return [];
  const heading = seen[start];
  if (heading === undefined) return [];
  const next = seen.slice(start + 1).find((candidate) => candidate.level <= heading.level);
  return lines.slice(heading.index + 1, next?.index ?? lines.length);
}

/** Groups a section into bullets, keeping indented lines and code fences with them. */
function checksIn(section: readonly string[]): string[] {
  const checks: string[] = [];
  let current: string[] | undefined;
  let fenced = false;
  for (const line of section) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      current ??= [];
      current.push(line);
      continue;
    }
    if (!fenced && /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      if (current !== undefined) checks.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current === undefined) {
      if (line.trim() !== '') current = [line];
      continue;
    }
    current.push(line);
  }
  if (current !== undefined) checks.push(current.join('\n'));
  return checks.map((check) => check.trim()).filter((check) => check !== '');
}

/** Reviews one check line or bullet. */
function reviewCheck(text: string): AcceptanceCheck {
  const executable = COMMAND.test(text) && EXPECTED_RESULT.test(text);
  const visualOnly = !executable && HUMAN_JUDGEMENT.test(text) && VISUAL_SUBJECT.test(text);
  return { text, executable, visualOnly };
}

/**
 * Reviews an Issue body against the executable-acceptance-check policy.
 *
 * A body is `ok` for a `ready` Issue when at least one acceptance check names a
 * command and its expected result, and no check asks a person to judge what
 * they see.
 */
export function reviewAcceptanceCheck(body: string): AcceptanceReview {
  const checks = checksIn(acceptanceSection(body)).map(reviewCheck);
  const visualOnly = checks.filter((check) => check.visualOnly).map((check) => check.text);
  const executable = checks.some((check) => check.executable);
  return { executable, visualOnly, ok: executable && visualOnly.length === 0, checks };
}

/** The minimum Issue shape the readiness policy needs. */
export interface LabelledIssue {
  title: string;
  body: string;
  labels: string[];
}

/** The outcome of applying the readiness policy to a reported Issue list. */
export interface AcceptancePolicyResult<T extends LabelledIssue> {
  issues: T[];
  /** Titles moved from `ready` to `needs-human`. */
  relabelled: string[];
}

/**
 * Moves `ready` Issues without an executable acceptance check to `needs-human`.
 *
 * This is the last line of defence before `report_issues` stores a draft. The
 * to-issues skill should already relabel them, but a model that misses the rule
 * must not hand an Agent work it cannot verify.
 */
export function relabelUnverifiableIssues<T extends LabelledIssue>(
  issues: readonly T[],
): AcceptancePolicyResult<T> {
  const relabelled: string[] = [];
  const reviewed = issues.map((issue) => {
    if (!issue.labels.includes('ready') || reviewAcceptanceCheck(issue.body).ok) {
      return issue;
    }
    relabelled.push(issue.title);
    const labels = issue.labels.filter((label) => label !== 'ready');
    if (!labels.includes('needs-human')) labels.push('needs-human');
    return { ...issue, labels };
  });
  return { issues: reviewed, relabelled };
}
