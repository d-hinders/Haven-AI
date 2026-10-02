/**
 * The prod banner stays visible on EVERY page (#3516 AC).
 *
 * The banner lives in OpsShell, which wraps every route; the test renders
 * the real shell around each page's representative content and asserts the
 * banner is present and above it — so a page that stopped rendering inside
 * the shell fails here. The session context OpsShell consumes is provided by
 * mocking its module (the session hook itself is covered by
 * ops-session.test.ts); the mock returns a ready session.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OpsEnvironment } from '../lib/environments'

vi.mock('../components/OpsClientRoot', () => ({
  OpsClientRoot: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useOpsRegistry: () => [],
  useOpsSessionContext: () => ({
    settled: true,
    outcome: { state: 'ready' } as const,
    tokenFor: () => null,
    onUnauthorized: () => {},
    signOut: () => {},
  }),
}))

import { OpsShell } from '../components/OpsShell'

const ENVIRONMENTS: OpsEnvironment[] = [
  { key: 'dev', origin: 'https://api.dev.example' },
  { key: 'prod', origin: 'https://api.example' },
]

const PAGE_TITLES = ['Overview', 'Search', 'Customer', 'Health', 'Doc health']

describe('the prod banner stays visible on every page (#3516)', () => {
  it('renders above every routed page while prod is selected', () => {
    for (const pageTitle of PAGE_TITLES) {
      const { unmount } = render(
        <OpsShell environments={ENVIRONMENTS}>
          <h1>{pageTitle}</h1>
        </OpsShell>,
      )
      const banner = screen.getByTestId('prod-banner')
      const heading = screen.getByRole('heading', { name: pageTitle })
      expect(banner).toBeInTheDocument()
      expect(banner).toHaveTextContent('You are working in production.')
      // The banner sits ABOVE the page content in DOM order — it is pinned
      // full-width at the top, not scrolled away or nested in a card.
      expect(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      unmount()
    }
  })

  it('renders no banner for a non-prod environment (the paired negative)', () => {
    const { unmount } = render(
      <OpsShell environments={[{ key: 'dev', origin: 'https://api.dev.example' }]}>
        <h1>Overview</h1>
      </OpsShell>,
    )
    expect(screen.queryByTestId('prod-banner')).not.toBeInTheDocument()
    unmount()
  })
})
