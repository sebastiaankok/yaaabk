import { grillMeError } from './errors';
import type { GeneratedIssue } from './types';

/**
 * Strips an optional Markdown code fence around the JSON. The skill is asked
 * for raw JSON, but a fence is a common LLM habit and costs nothing to allow.
 */
function unfence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return [...value];
  }
  return undefined;
}

/**
 * Parses the JSON payload of an `<ISSUES>` block into {@link GeneratedIssue}s.
 *
 * Throws an `invalid-issues`-tagged error when the payload is not a JSON array
 * of issues with a title, so the session can surface it as an `error` event
 * rather than emitting a half-formed issue list.
 */
export function parseGeneratedIssues(content: string): GeneratedIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(content));
  } catch (error) {
    throw grillMeError('invalid-issues', 'The issues block is not valid JSON', error);
  }

  if (!Array.isArray(parsed)) {
    throw grillMeError('invalid-issues', 'The issues block must be a JSON array');
  }

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw grillMeError('invalid-issues', `Issue at index ${index} is not an object`);
    }
    const { title, body, labels, depends_on: dependsOn } = item as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim() === '') {
      throw grillMeError('invalid-issues', `Issue at index ${index} is missing a title`);
    }
    const parsedLabels = stringArray(labels);
    const parsedDependencies = stringArray(dependsOn);
    if (parsedLabels === undefined) {
      throw grillMeError('invalid-issues', `Issue "${title}" has a non-string labels entry`);
    }
    if (parsedDependencies === undefined) {
      throw grillMeError('invalid-issues', `Issue "${title}" has a non-string depends_on entry`);
    }
    return {
      title,
      body: typeof body === 'string' ? body : '',
      labels: parsedLabels,
      depends_on: parsedDependencies,
    };
  });
}
