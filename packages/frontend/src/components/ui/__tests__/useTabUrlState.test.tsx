import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReplace, mockSearch } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockSearch: { value: '' },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch.value),
}))

import { useTabUrlState } from '../useTabUrlState'

/**
 * The one `?tab=` rule (#4573). Each case is a page's own behaviour, pinned
 * here so the three pages cannot drift apart again: Account and Agent clear
 * the other parameters on a switch, Settings keeps them, and the default tab
 * is omitted from the URL.
 */

const ACCOUNT_TABS = ['activity', 'agents', 'security'] as const
const AGENT_TABS = ['activity', 'tool-calls', 'settings'] as const
const SETTINGS_TABS = ['general', 'security', 'business'] as const

beforeEach(() => {
  mockReplace.mockReset()
  mockSearch.value = ''
})

describe('useTabUrlState', () => {
  it('Account: a tab switch clears the other parameters (#4226)', () => {
    mockSearch.value = 'tab=agents&q=coffee'
    const { result } = renderHook(() =>
      useTabUrlState({ tabs: ACCOUNT_TABS, defaultTab: 'activity', basePath: '/accounts/safe-1' }),
    )
    expect(result.current.tab).toBe('agents')

    act(() => result.current.setTab('security'))

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenLastCalledWith('/accounts/safe-1?tab=security', { scroll: false })
  })

  it('Agent: a tab switch clears the tab filters too', () => {
    mockSearch.value = 'tab=tool-calls&paymentId=pay_1'
    const { result } = renderHook(() =>
      useTabUrlState({ tabs: AGENT_TABS, defaultTab: 'activity', basePath: '/agents/agent-1' }),
    )
    expect(result.current.tab).toBe('tool-calls')

    act(() => result.current.setTab('settings'))

    expect(mockReplace).toHaveBeenLastCalledWith('/agents/agent-1?tab=settings', { scroll: false })
  })

  it('Settings: a tab switch keeps the other parameters', () => {
    mockSearch.value = 'provider=fortnox&connect=connected'
    const { result } = renderHook(() =>
      useTabUrlState({
        tabs: SETTINGS_TABS,
        defaultTab: 'general',
        basePath: '/settings',
        keepOtherParams: true,
      }),
    )
    expect(result.current.tab).toBe('general')
    expect(result.current.urlTab).toBeNull()

    act(() => result.current.setTab('business'))

    expect(mockReplace).toHaveBeenLastCalledWith(
      '/settings?provider=fortnox&connect=connected&tab=business',
      { scroll: false },
    )
  })

  it('omits the default tab from the URL instead of writing it', () => {
    mockSearch.value = 'tab=security'
    const { result } = renderHook(() =>
      useTabUrlState({
        tabs: SETTINGS_TABS,
        defaultTab: 'general',
        basePath: '/settings',
        keepOtherParams: true,
      }),
    )
    expect(result.current.tab).toBe('security')

    act(() => result.current.setTab('general'))

    expect(mockReplace).toHaveBeenLastCalledWith('/settings', { scroll: false })
  })

  it('omits the default tab on a page that clears the other parameters', () => {
    mockSearch.value = 'tab=agents&q=coffee'
    const { result } = renderHook(() =>
      useTabUrlState({ tabs: ACCOUNT_TABS, defaultTab: 'activity', basePath: '/accounts/safe-1' }),
    )

    act(() => result.current.setTab('activity'))

    expect(mockReplace).toHaveBeenLastCalledWith('/accounts/safe-1', { scroll: false })
  })

  it('falls back to the default for an unknown or absent tab, and reports urlTab null', () => {
    mockSearch.value = 'tab=nonsense'
    const { result } = renderHook(() =>
      useTabUrlState({ tabs: ACCOUNT_TABS, defaultTab: 'activity', basePath: '/accounts/safe-1' }),
    )
    expect(result.current.tab).toBe('activity')
    expect(result.current.urlTab).toBeNull()
  })

  it('writes the tab it is given — the page owns the "already active" check', () => {
    mockSearch.value = 'tab=agents'
    const { result } = renderHook(() =>
      useTabUrlState({ tabs: ACCOUNT_TABS, defaultTab: 'activity', basePath: '/accounts/safe-1' }),
    )

    act(() => result.current.setTab('agents'))

    expect(mockReplace).toHaveBeenLastCalledWith('/accounts/safe-1?tab=agents', { scroll: false })
  })
})
