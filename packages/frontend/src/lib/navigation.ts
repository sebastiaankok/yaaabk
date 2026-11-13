export interface NavItem {
  href: string;
  label: string;
}

/** Primary navigation for the app shell. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Projects' },
  { href: '/settings', label: 'Settings' },
];

/** Whether `href` should be highlighted for the given `currentPath`. */
export function isActivePath(currentPath: string, href: string): boolean {
  if (href === '/') {
    return currentPath === '/';
  }
  return currentPath === href || currentPath.startsWith(`${href}/`);
}
