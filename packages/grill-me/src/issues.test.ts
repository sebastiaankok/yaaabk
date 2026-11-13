import { describe, expect, it } from 'vitest';
import { parseGeneratedIssues } from './issues';

/** The `kind` of the typed error a call throws, if any. */
function kindOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as { kind?: unknown }).kind;
  }
  return undefined;
}

describe('parseGeneratedIssues', () => {
  it('parses titles, bodies, labels and dependencies', () => {
    const issues = parseGeneratedIssues(
      JSON.stringify([
        {
          title: 'Add auth',
          body: 'Implement login.',
          labels: ['ready'],
          depends_on: ['Set up database'],
        },
        { title: 'Add dashboard', body: 'Show stats.', labels: ['blocked'], depends_on: [] },
      ]),
    );

    expect(issues).toEqual([
      {
        title: 'Add auth',
        body: 'Implement login.',
        labels: ['ready'],
        depends_on: ['Set up database'],
      },
      { title: 'Add dashboard', body: 'Show stats.', labels: ['blocked'], depends_on: [] },
    ]);
  });

  it('defaults missing labels and dependencies to empty arrays', () => {
    const issues = parseGeneratedIssues(JSON.stringify([{ title: 'Add auth', body: 'Login.' }]));

    expect(issues).toEqual([{ title: 'Add auth', body: 'Login.', labels: [], depends_on: [] }]);
  });

  it('tolerates surrounding whitespace and a fenced code block', () => {
    const issues = parseGeneratedIssues('\n```json\n[{"title":"Add auth"}]\n```\n');

    expect(issues).toEqual([{ title: 'Add auth', body: '', labels: [], depends_on: [] }]);
  });

  it('rejects content that is not valid JSON', () => {
    expect(kindOf(() => parseGeneratedIssues('not json'))).toBe('invalid-issues');
  });

  it('rejects a payload that is not an array of titled issues', () => {
    expect(kindOf(() => parseGeneratedIssues('{"title":"Add auth"}'))).toBe('invalid-issues');
    expect(kindOf(() => parseGeneratedIssues('[{"body":"no title"}]'))).toBe('invalid-issues');
  });
});
