import { describe, expect, it } from 'vitest';
import { labelSelector, resourcePath } from './selectors';

describe('labelSelector', () => {
  it('joins labels into a comma-separated selector', () => {
    expect(labelSelector({ app: 'todo', issue: '42' })).toBe('app=todo,issue=42');
  });

  it('returns undefined when there is nothing to select', () => {
    expect(labelSelector()).toBeUndefined();
    expect(labelSelector({})).toBeUndefined();
  });
});

describe('resourcePath', () => {
  it('builds a namespaced path for a grouped resource', () => {
    expect(resourcePath('batch/v1', 'Job', 'project-a')).toBe(
      '/apis/batch/v1/namespaces/project-a/jobs',
    );
  });

  it('builds a cluster-scoped path for core resources without a namespace', () => {
    expect(resourcePath('v1', 'Namespace')).toBe('/api/v1/namespaces');
  });

  it('builds a namespaced core path', () => {
    expect(resourcePath('v1', 'Secret', 'project-a')).toBe('/api/v1/namespaces/project-a/secrets');
  });

  it('builds a path for a custom resource', () => {
    expect(resourcePath('argoproj.io/v1alpha1', 'Application', 'project-a')).toBe(
      '/apis/argoproj.io/v1alpha1/namespaces/project-a/applications',
    );
  });
});
