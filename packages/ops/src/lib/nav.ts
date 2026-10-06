/**
 * The console's page registry (#3516). One list drives the nav and the
 * route guard, so a page added without a nav entry (or the reverse) is a
 * one-line edit away from visible.
 */
export interface OpsNavItem {
  href: string
  label: string
  /** Whether `pathname` IS this page (prefix match for the customer page's ids). */
  match: (pathname: string) => boolean
}

export const OPS_NAV_ITEMS: OpsNavItem[] = [
  { href: '/overview', label: 'Overview', match: (p) => p === '/overview' },
  { href: '/feedback', label: 'Feedback', match: (p) => p === '/feedback' },
  { href: '/search', label: 'Search', match: (p) => p === '/search' },
  { href: '/health', label: 'Health', match: (p) => p === '/health' },
  { href: '/doc-health', label: 'Doc health', match: (p) => p === '/doc-health' },
  // The customer page is reached from search and from the health lists; it
  // never appears in the nav itself, but its active state maps to nothing.
]
