/**
 * The two OFF states of the accounting feed (#2869).
 *
 * The invariant the owner decision turns on: `hosted && !enabled` is Coming
 * soon, `!hosted` is "not available on self-hosted", and the second must
 * NEVER read as the first. Both assert the absence of any connect or sync
 * control BY ROLE — a disabled button is still reachable to a screen reader
 * and would suggest a control that does not exist.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { en } from '@/lib/i18n/messages/en'

const { mockApi } = vi.hoisted(() => ({ mockApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ApiRequestError: actual.ApiRequestError, api: mockApi }
})

import { ComingSoon, SelfHostedUnavailable, STATIC_PLATFORMS } from '@/components/accounting/ComingSoon'

const COMING_SOON_STRING = en.common.comingSoon

function renderIn(node: React.ReactNode) {
  return render(<LocaleProvider>{node}</LocaleProvider>)
}

/** No connect and no sync control is REACHABLE, disabled ones included. */
function expectNoActions() {
  for (const name of [/connect/i, /reconnect/i, /sync/i, /disconnect/i]) {
    expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByRole('link', { name })).toBeNull()
  }
}

describe('ComingSoon (hosted, flag off)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.get.mockResolvedValue({
      providers: [
        { id: 'fortnox', displayName: 'Fortnox' },
        { id: 'accounted', displayName: 'Accounted' },
      ],
    })
  })

  it('explains what the feed will do, marks it Coming soon, and offers no action', async () => {
    renderIn(<ComingSoon />)
    expect(screen.getByText(en.accountingPage.comingSoon.title)).toBeInTheDocument()
    expect(screen.getAllByText(COMING_SOON_STRING).length).toBeGreaterThan(0)
    expect(screen.getByText(en.accountingPage.comingSoon.body)).toBeInTheDocument()
    expect(screen.getByText(en.accountingPage.comingSoon.notYet)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Accounted')).toBeInTheDocument())
    expectNoActions()
  })

  it('speaks to the user in the non-asserting register, not to the owner (#2869 design review)', () => {
    renderIn(<ComingSoon />)
    const text = document.body.textContent ?? ''
    // What the accountant does and what Haven does not decide — said to the user.
    expect(text).toContain('your accountant codes and books them')
    expect(text).toContain('Haven does not decide accounts or VAT')
    expect(text).toContain(en.accountingPage.comingSoon.platformsBody)
    // The owner-facing phrasing the first cut carried.
    expect(text).not.toContain('Haven asserts nothing')
    expect(text).not.toContain('Listed, not endorsed')
    expect(text).not.toContain('separate decision')
  })

  it('lists the live providers when the registry answers', async () => {
    renderIn(<ComingSoon />)
    await waitFor(() => expect(screen.getByText('Fortnox')).toBeInTheDocument())
    expect(screen.getByText('Accounted')).toBeInTheDocument()
    // The static list is the fallback, not what rendered here.
    expect(screen.queryByText('Igdrasil')).toBeNull()
  })

  it('falls back to the static platform list when the registry does not answer', async () => {
    mockApi.get.mockRejectedValue(new Error('nope'))
    renderIn(<ComingSoon />)
    for (const p of STATIC_PLATFORMS) {
      await waitFor(() => expect(screen.getByText(p.displayName)).toBeInTheDocument())
    }
    expectNoActions()
  })
})

describe('SelfHostedUnavailable (not hosted)', () => {
  it('says the feed is not available here and NEVER that it is coming soon', () => {
    renderIn(<SelfHostedUnavailable />)
    expect(screen.getByText(en.accountingPage.selfHosted.title)).toBeInTheDocument()
    expect(screen.getByText(en.accountingPage.selfHosted.body)).toBeInTheDocument()
    // The load-bearing negative: the coming-soon string appears nowhere.
    expect(document.body.textContent).not.toContain(COMING_SOON_STRING)
    expect(document.body.textContent).not.toContain(en.accountingPage.comingSoon.title)
    expectNoActions()
  })

  it('lists no platforms — nothing is scheduled for a self-hosted box', () => {
    renderIn(<SelfHostedUnavailable />)
    for (const p of STATIC_PLATFORMS) expect(screen.queryByText(p.displayName)).toBeNull()
  })
})
