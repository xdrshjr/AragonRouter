import {
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

/** Console base path; the whole authenticated UI lives under it. */
export const CONSOLE_BASE_PATH = '/console';

/** Login route; the only unauthenticated page. */
export const LOGIN_PATH = '/login';

export interface NavItem {
  href: string;
  /** Sidebar and topbar label (English only - the UI has no localized copy). */
  label: string;
  /** Short description used as the topbar subtitle. */
  hint: string;
  icon: LucideIcon;
  /** Exact match only (the overview page must not stay active on its children). */
  exact: boolean;
}

/** Sidebar order, also used to resolve the current page title in the topbar. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: CONSOLE_BASE_PATH,
    label: 'Overview',
    hint: 'Traffic, latency and errors',
    icon: LayoutDashboard,
    exact: true,
  },
  {
    href: `${CONSOLE_BASE_PATH}/keys`,
    label: 'API keys',
    hint: 'Issue and revoke client keys',
    icon: KeyRound,
    exact: false,
  },
  {
    href: `${CONSOLE_BASE_PATH}/providers`,
    label: 'Providers',
    hint: 'Upstream credentials and health',
    icon: Server,
    exact: false,
  },
  {
    href: `${CONSOLE_BASE_PATH}/logs`,
    label: 'Logs',
    hint: 'Every proxied request',
    icon: ScrollText,
    exact: false,
  },
  {
    href: `${CONSOLE_BASE_PATH}/settings`,
    label: 'Settings',
    hint: 'Read-only configuration',
    icon: Settings2,
    exact: false,
  },
];

/**
 * True when `pathname` belongs to `href`.
 * `/console` matches exactly so the overview item goes inactive on sub-pages;
 * every other item also matches its children.
 */
export function isActivePath(pathname: string | null | undefined, href: string, exact = false): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  // Trailing slashes are accepted by Next; compare without them.
  const current = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (current === href) return true;
  if (exact) return false;
  return current.startsWith(`${href}/`);
}

/** Resolve the nav item for a pathname, falling back to the overview entry. */
export function findNavItem(pathname: string | null | undefined): NavItem {
  for (const item of NAV_ITEMS) {
    if (isActivePath(pathname, item.href, item.exact)) return item;
  }
  const fallback = NAV_ITEMS[0];
  if (!fallback) throw new Error('NAV_ITEMS must not be empty');
  return fallback;
}

/**
 * Sanitise the `?next=` value after a login redirect.
 *
 * Only a same-origin absolute path is accepted: `//evil.example`, `https://...`,
 * backslashes and `/\` variants are all rejected, which keeps `/login?next=` from
 * becoming an open redirect. The login page itself is never a valid target.
 */
export function sanitizeNextPath(
  value: string | null | undefined,
  fallback: string = CONSOLE_BASE_PATH,
): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 512) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  // `//host` and `/\host` are protocol-relative URLs in browsers.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  if (candidate.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  if (candidate === LOGIN_PATH || candidate.startsWith(`${LOGIN_PATH}?`) || candidate.startsWith(`${LOGIN_PATH}/`)) {
    return fallback;
  }
  return candidate;
}

