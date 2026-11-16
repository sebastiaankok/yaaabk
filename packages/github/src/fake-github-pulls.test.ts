import { describe, expect, it } from 'vitest';
import { createFakeGitHubPulls } from './fake-github-pulls';
import type { GitHubError } from './types';

const notFound: GitHubError = {
  kind: 'not-found',
  operation: 'create-review',
  message: 'Pull request not found',
};

describe('createFakeGitHubPulls', () => {
  describe('createReview', () => {
    it('records the review against the pull request', async () => {
      const pulls = createFakeGitHubPulls();

      const result = await pulls.createReview('acme/todo-app', 7, {
        event: 'request-changes',
        body: 'Please fix the typo.',
      });

      expect(result.ok && result.value).toMatchObject({
        event: 'request-changes',
        body: 'Please fix the typo.',
      });
      expect(pulls.reviews('acme/todo-app', 7)).toHaveLength(1);
      expect(pulls.reviews('acme/todo-app', 8)).toHaveLength(0);
    });

    it('keeps reviews in the order they were posted', async () => {
      const pulls = createFakeGitHubPulls();

      await pulls.createReview('acme/todo-app', 7, { event: 'approve', body: 'first' });
      await pulls.createReview('acme/todo-app', 7, {
        event: 'request-changes',
        body: 'second',
      });

      expect(pulls.reviews('acme/todo-app', 7).map((review) => review.body)).toEqual([
        'first',
        'second',
      ]);
    });

    it('surfaces a queued failure', async () => {
      const pulls = createFakeGitHubPulls();
      pulls.failNext('create-review', notFound);

      const result = await pulls.createReview('acme/todo-app', 7, {
        event: 'approve',
        body: 'Looks good.',
      });

      expect(result).toEqual({ ok: false, error: notFound });
      expect(pulls.reviews('acme/todo-app', 7)).toHaveLength(0);
    });
  });
});
