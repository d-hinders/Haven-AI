import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()
const mockUsePathname = vi.fn()
const mockPush = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))


vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import Sidebar from '@/components/sidebar/Sidebar'

describe('Sidebar', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUsePathname.mockReset()
    mockPush.mockReset()

    mockUsePathname.mockReturnValue('/dashboard')
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout: vi.fn(),
    })
  })

  it('renders three labeled clusters with the core money loop first (#858)', () => {
    render(<Sidebar />)
    const labels = ['Money', 'Agent tools', 'Admin'].map((l) => screen.getByText(l))
    expect(labels).toHaveLength(3)
    // Core loop order and routes unchanged (scoped to the nav — the logo also links to /dashboard):
    const links = Array.from(document.querySelector('nav')!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    const nav = links.filter((href) =>
      ['/dashboard', '/accounts', '/transactions', '/agents', '/approvals', '/catalog', '/contacts', '/reporting', '/custody'].includes(href ?? ''),
    )
    // '/approvals' stays in the FILTER above deliberately: the filter is what
    // makes this assertion able to see a re-added Approvals entry. Removing it
    // from both sides would turn the equality into a guard over the empty set.
    expect(nav).toEqual([
      '/dashboard', '/accounts', '/transactions', '/agents',
      '/catalog', '/contacts',
      '/reporting', '/custody',
    ])
    // The Money label precedes the Agent tools label in the DOM:
    const money = screen.getByText('Money')
    const tools = screen.getByText('Agent tools')
    expect(money.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // #1989 (epic #1440): the Approvals entry and its live badge are DELETED, for
  // every user — not hidden per-account as #1079 had it. The approval queue was
  // a legacy-rail concept, `POST /approvals/:id/approve` answers 410 (#1986),
  // and the queue UI is gone, so the nav entry could only dead-end.
  //
  // Asserted on a MIXED-rail user, which is the case #1079's old
  // `onlyDelegationAccounts` predicate deliberately kept the entry for. If the
  // entry ever comes back, it comes back here first.
  it('offers no Approvals entry even for a user holding a legacy Safe account', () => {
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [
          { id: 's1', account_type: 'safe' },
          { id: 's2', account_type: 'delegator_hybrid' },
        ],
      },
      logout: vi.fn(),
    })
    render(<Sidebar />)
    expect(screen.queryByRole('link', { name: /Approvals/ })).toBeNull()
    const hrefs = Array.from(document.querySelector('nav')!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    expect(hrefs).not.toContain('/approvals')
  })

  it('opens profile from the bottom-left identity area', () => {
    render(<Sidebar />)

    const profileLink = screen.getByRole('link', { name: 'Open profile for Ada Lovelace' })
    expect(profileLink).toHaveAttribute('href', '/profile')
  })

  it('shows Profile, Settings, and sign out in the account menu', async () => {
    const user = userEvent.setup()
    const logout = vi.fn()
    mockUseAuth.mockReturnValue({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        safes: [],
      },
      logout,
    })
    render(<Sidebar />)

    await user.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    expect(logout).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/')
  })
})
