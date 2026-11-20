import { describe, expect, it } from 'vitest';
import { PROJECT_TABS, SIDEBAR_DESTINATIONS, projectTabPath, resolveShell } from './shell';

describe('SIDEBAR_DESTINATIONS', () => {
  it('offers Projects and Settings with unique absolute hrefs', () => {
    expect(SIDEBAR_DESTINATIONS.map((item) => item.id)).toEqual(['projects', 'settings']);
    const hrefs = SIDEBAR_DESTINATIONS.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
    }
  });
});

describe('resolveShell', () => {
  it('marks the login and setup routes as bare auth routes', () => {
    for (const pathname of ['/login', '/setup']) {
      const shell = resolveShell(pathname);

      expect(shell.authRoute).toBe(true);
      expect(shell.destination).toBeNull();
      expect(shell.projectId).toBeNull();
      expect(shell.activeProjectTab).toBeNull();
      expect(shell.breadcrumbs).toEqual([]);
    }
  });

  it('highlights Projects for the project list and every project route', () => {
    for (const pathname of ['/', '/projects/new', '/projects/p1', '/projects/p1/stats']) {
      expect(resolveShell(pathname).destination).toBe('projects');
    }
  });

  it('highlights Settings only for the settings route', () => {
    expect(resolveShell('/settings').destination).toBe('settings');
    expect(resolveShell('/settings/keys').destination).toBe('settings');
  });

  it('leaves unknown routes without a destination, project or tab', () => {
    const shell = resolveShell('/does-not-exist');

    expect(shell.authRoute).toBe(false);
    expect(shell.destination).toBeNull();
    expect(shell.projectId).toBeNull();
    expect(shell.activeProjectTab).toBeNull();
    expect(shell.breadcrumbs).toEqual([]);
  });
});

describe('project tabs', () => {
  it('builds each tab path from the project id', () => {
    expect(projectTabPath('p1', 'overview')).toBe('/projects/p1');
    expect(projectTabPath('p1', 'plan')).toBe('/projects/p1/plan');
    expect(projectTabPath('p1', 'review')).toBe('/projects/p1/issues/review');
    expect(projectTabPath('p1', 'issues')).toBe('/projects/p1/issues');
    expect(projectTabPath('p1', 'stats')).toBe('/projects/p1/stats');
  });

  it('resolves the active project tab, preferring Review over Issues', () => {
    const expectations = [
      ['/projects/p1', 'overview'],
      ['/projects/p1/plan', 'plan'],
      ['/projects/p1/issues', 'issues'],
      ['/projects/p1/issues/review', 'review'],
      ['/projects/p1/stats', 'stats'],
    ] as const;

    for (const [pathname, tab] of expectations) {
      expect(resolveShell(pathname).activeProjectTab).toBe(tab);
      expect(resolveShell(pathname).projectId).toBe('p1');
    }
  });

  it('offers no project tabs outside a project route', () => {
    expect(resolveShell('/').projectId).toBeNull();
    expect(resolveShell('/projects/new').projectId).toBeNull();
    expect(resolveShell('/settings').projectId).toBeNull();
  });

  it('keeps the tab order in one place', () => {
    expect(PROJECT_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'plan',
      'review',
      'issues',
      'stats',
    ]);
  });
});

describe('breadcrumbs', () => {
  it('starts at Projects for the project list and the create flow', () => {
    expect(resolveShell('/').breadcrumbs).toEqual([{ label: 'Projects' }]);
    expect(resolveShell('/projects/new').breadcrumbs).toEqual([
      { label: 'Projects', href: '/' },
      { label: 'New project' },
    ]);
  });

  it('names a project instead of showing its id', () => {
    expect(resolveShell('/projects/p1', 'todo-app').breadcrumbs).toEqual([
      { label: 'Projects', href: '/' },
      { label: 'todo-app' },
    ]);
  });

  it('falls back to a generic Project label when the name is missing', () => {
    expect(resolveShell('/projects/p1').breadcrumbs).toEqual([
      { label: 'Projects', href: '/' },
      { label: 'Project' },
    ]);
  });

  it('builds the trail for nested project routes', () => {
    expect(resolveShell('/projects/p1/issues/review', 'todo-app').breadcrumbs).toEqual([
      { label: 'Projects', href: '/' },
      { label: 'todo-app', href: '/projects/p1' },
      { label: 'Review' },
    ]);
    expect(resolveShell('/projects/p1/stats', 'todo-app').breadcrumbs).toEqual([
      { label: 'Projects', href: '/' },
      { label: 'todo-app', href: '/projects/p1' },
      { label: 'Stats' },
    ]);
  });

  it('shows a single Settings crumb', () => {
    expect(resolveShell('/settings').breadcrumbs).toEqual([{ label: 'Settings' }]);
  });

  it('ignores a trailing slash', () => {
    expect(resolveShell('/projects/p1/stats/', 'todo-app').activeProjectTab).toBe('stats');
  });
});
