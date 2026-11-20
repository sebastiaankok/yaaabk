/**
 * The application shell model.
 *
 * Given only a pathname (and, when the page already knows it, a Project name)
 * this module decides which sidebar destination is active, which Project the
 * route belongs to, which Project tab is selected and what the breadcrumb trail
 * reads. Route-to-section mapping lives here and nowhere else, so the layout,
 * sidebar and page headers share one interpretation of a URL.
 */

export type SidebarDestinationId = 'projects' | 'settings';

export interface SidebarDestination {
  id: SidebarDestinationId;
  label: string;
  href: string;
}

/** Primary navigation for the app shell. */
export const SIDEBAR_DESTINATIONS: readonly SidebarDestination[] = [
  { id: 'projects', label: 'Projects', href: '/' },
  { id: 'settings', label: 'Settings', href: '/settings' },
];

export type ProjectTabId = 'overview' | 'plan' | 'review' | 'issues' | 'stats';

export interface ProjectTab {
  id: ProjectTabId;
  label: string;
  /** The path below `/projects/<id>`, empty for the overview. */
  segment: string;
}

/** Project tabs, in the order they appear in the header. */
export const PROJECT_TABS: readonly ProjectTab[] = [
  { id: 'overview', label: 'Overview', segment: '' },
  { id: 'plan', label: 'Plan', segment: 'plan' },
  { id: 'review', label: 'Review', segment: 'issues/review' },
  { id: 'issues', label: 'Issues', segment: 'issues' },
  { id: 'stats', label: 'Stats', segment: 'stats' },
];

/** Routes that make up the authentication flow and render without the shell. */
export const AUTH_PATHNAMES: readonly string[] = ['/login', '/setup'];

export interface Breadcrumb {
  label: string;
  /** Omitted on the current page, which is exposed with `aria-current`. */
  href?: string;
}

export interface ShellModel {
  /** True on login and setup, where the layout is deliberately bare. */
  authRoute: boolean;
  /** The highlighted sidebar destination, or `null` for unknown routes. */
  destination: SidebarDestinationId | null;
  /** The Project the route belongs to, or `null` outside project routes. */
  projectId: string | null;
  /** The selected Project tab, or `null` outside project routes. */
  activeProjectTab: ProjectTabId | null;
  /** The trail from the top-level destination to the current page. */
  breadcrumbs: Breadcrumb[];
}

/** The path of a Project tab, ready to be passed to `resolve()` or an anchor. */
export function projectTabPath(projectId: string, tab: ProjectTabId): string {
  const segment = PROJECT_TABS.find((candidate) => candidate.id === tab)?.segment ?? '';
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return segment === '' ? base : `${base}/${segment}`;
}

/** Drop the query, hash and any trailing slash so matching is unambiguous. */
function normalize(pathname: string): string {
  let path = pathname.split(/[?#]/, 1)[0] ?? '/';
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path === '' ? '/' : path;
}

function destinationFor(path: string): SidebarDestinationId | null {
  if (path === '/settings' || path.startsWith('/settings/')) return 'settings';
  if (path === '/' || path === '/projects' || path.startsWith('/projects/')) return 'projects';
  return null;
}

interface ProjectRoute {
  id: string;
  tab: ProjectTabId | null;
}

function projectRouteFor(path: string): ProjectRoute | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'projects' || segments.length < 2) return null;
  if (segments[1] === 'new') return null;

  const rest = segments.slice(2).join('/');
  const tab = PROJECT_TABS.find((candidate) => candidate.segment === rest)?.id ?? null;
  return { id: decodeURIComponent(segments[1]), tab };
}

function breadcrumbsFor(
  path: string,
  project: ProjectRoute | null,
  projectName: string | null,
): Breadcrumb[] {
  if (path === '/') return [{ label: 'Projects' }];
  if (path === '/projects/new') {
    return [{ label: 'Projects', href: '/' }, { label: 'New project' }];
  }
  if (path === '/settings') return [{ label: 'Settings' }];
  if (path.startsWith('/settings/')) {
    return [{ label: 'Settings', href: '/settings' }, { label: 'Settings' }];
  }

  if (project !== null) {
    const name = projectName?.trim() || 'Project';
    const trail: Breadcrumb[] = [{ label: 'Projects', href: '/' }];
    const tab = PROJECT_TABS.find((candidate) => candidate.id === project.tab);
    if (tab === undefined) {
      trail.push({ label: name });
    } else if (tab.id === 'overview') {
      trail.push({ label: name });
    } else {
      trail.push({ label: name, href: projectTabPath(project.id, 'overview') });
      trail.push({ label: tab.label });
    }
    return trail;
  }

  return [];
}

/**
 * Resolve a pathname into the shell's view of it.
 *
 * `projectName` is optional: the layout does not fetch Project data, so it
 * calls this without a name; pages that have already loaded their Project pass
 * the name so their breadcrumb reads `todo-app` rather than `Project`.
 */
export function resolveShell(pathname: string, projectName?: string | null): ShellModel {
  const path = normalize(pathname);

  if (AUTH_PATHNAMES.includes(path)) {
    return {
      authRoute: true,
      destination: null,
      projectId: null,
      activeProjectTab: null,
      breadcrumbs: [],
    };
  }

  const project = projectRouteFor(path);
  const destination = destinationFor(path);

  return {
    authRoute: false,
    destination,
    projectId: project?.id ?? null,
    activeProjectTab: project?.tab ?? null,
    breadcrumbs:
      destination === null && project === null
        ? []
        : breadcrumbsFor(path, project, projectName ?? null),
  };
}
