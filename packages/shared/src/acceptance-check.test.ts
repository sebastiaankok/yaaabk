import { describe, expect, it } from 'vitest';
import { relabelUnverifiableIssues, reviewAcceptanceCheck } from './acceptance-check';

function body(...checks: string[]): string {
  return ['## What to build', 'Persist a bookmark.', '', '## Acceptance criteria', ...checks].join(
    '\n',
  );
}

describe('reviewAcceptanceCheck', () => {
  it('accepts a command with an expected result', () => {
    const review = reviewAcceptanceCheck(
      body('- [ ] `bun test packages/bookmarks` passes and reports the new test.'),
    );

    expect(review.ok).toBe(true);
    expect(review.visualOnly).toEqual([]);
  });

  it('rejects a visual-only check', () => {
    const review = reviewAcceptanceCheck(
      body(
        '- [ ] Read the page at 1280px and 375px wide. Confirm that the card centres and the header reads clearly.',
      ),
    );

    expect(review.ok).toBe(false);
    expect(review.executable).toBe(false);
    expect(review.visualOnly).toHaveLength(1);
  });

  it('rejects a body that only names an automated test without a command', () => {
    const review = reviewAcceptanceCheck(body('- [ ] Add an e2e test that covers the focus ring.'));

    expect(review.ok).toBe(false);
  });

  it('rejects a visual check that sits beside an executable check', () => {
    const review = reviewAcceptanceCheck(
      body(
        '- [ ] `bun test` passes.',
        '- [ ] Tab through the page and confirm that every control shows a focus ring.',
      ),
    );

    expect(review.ok).toBe(false);
    expect(review.visualOnly).toHaveLength(1);
  });

  it('accepts a rendered assertion when it names a command and its expected result', () => {
    const review = reviewAcceptanceCheck(
      body(
        '- [ ] `bun test packages/frontend/src/lib/button.spec.ts` passes and the focus ring assertion is green.',
      ),
    );

    expect(review.ok).toBe(true);
  });

  it('rejects a body without an acceptance section', () => {
    const review = reviewAcceptanceCheck('Persist a bookmark.');

    expect(review.ok).toBe(false);
  });
});

describe('relabelUnverifiableIssues', () => {
  it('moves ready issues without an executable check to needs-human', () => {
    const { issues, relabelled } = relabelUnverifiableIssues([
      {
        title: 'Centre the card',
        body: body('- [ ] Open the page and confirm that the card is centred.'),
        labels: ['ready'],
      },
      {
        title: 'Persist a bookmark',
        body: body('- [ ] `bun test` passes.'),
        labels: ['ready'],
      },
      {
        title: 'Choose a colour',
        body: 'Pick one.',
        labels: ['needs-human'],
      },
    ]);

    expect(relabelled).toEqual(['Centre the card']);
    expect(issues.map((issue) => issue.labels)).toEqual([
      ['needs-human'],
      ['ready'],
      ['needs-human'],
    ]);
  });

  it('leaves issues without the ready label alone', () => {
    const { issues, relabelled } = relabelUnverifiableIssues([
      { title: 'Pick a colour', body: 'By eye.', labels: ['refinement-needed'] },
    ]);

    expect(relabelled).toEqual([]);
    expect(issues[0]?.labels).toEqual(['refinement-needed']);
  });
});
