/**
 * The `/accounting` connection summary line (#2869), one test per state.
 *
 * The line is the page's answer to "where is my spend going right now" —
 * connected it names the provider, the company and the last push; in an
 * attention state it says what is wrong and links to Settings, where the
 * fix lives (#2868). It never offers a connect control of its own.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import { en } from '@/lib/i18n/messages/en'
import { FeedSummary, relativeTime } from '@/components/accounting/FeedSummary'
import { INTL_LOCALE } from '@/lib/i18n'
import { feedStatus } from './fixtures'
import type { AccountingFeedStatus } from '@/hooks/useAccountingFeed'

function renderSummary(overrides: Partial<AccountingFeedStatus> = {}) {
  return render(
    <LocaleProvider>
      <FeedSummary status={feedStatus(overrides)} />
    </LocaleProvider>,
  )
}

type Destination = NonNullable<AccountingFeedStatus['destination']>

const destination = (status: Destination['status'], extra: Partial<Destination> = {}): Destination => ({
  provider: 'fortnox',
  displayName: 'Fortnox',
  status,
  companyName: 'Ada Lovelace AB',
  lastPushAt: '2026-09-12T09:58:00.000Z',
  ...extra,
})

describe('FeedSummary', () => {
  it('connected: names the provider, the company and the last push', () => {
    const now = new Date('2026-09-12T10:00:00.000Z')
    vi.setSystemTime(now)
    renderSummary()
    const line = screen.getByTestId('feed-summary')
    expect(line).toHaveAttribute('data-status', 'connected')
    expect(line.textContent).toContain('Feeding Fortnox')
    expect(line.textContent).toContain('Ada Lovelace AB')
    expect(line.textContent).toContain('last push')
    vi.useRealTimers()
  })

  it('connected with nothing pushed yet says so instead of an empty time', () => {
    renderSummary({ destination: { ...destination('connected'), lastPushAt: null } })
    expect(screen.getByTestId('feed-summary').textContent).toContain(en.accountingPage.summary.nothingPushedYet)
  })

  it.each([
    ['needs_reauthorisation' as const, en.settings.accounting.status.needs_reauthorisation, /sign-in has expired/i],
    ['revoked_at_provider' as const, en.settings.accounting.status.revoked_at_provider, /Access was revoked in Fortnox/i],
  ])('%s: the attention chip, the sentence, and a way to Settings', (status, chip, sentence) => {
    renderSummary({ destination: destination(status), connected: false, companyName: null })
    const line = screen.getByTestId('feed-summary')
    expect(line).toHaveAttribute('data-status', status)
    expect(screen.getByText(chip)).toBeInTheDocument()
    expect(screen.getByText(sentence)).toBeInTheDocument()
    const fix = screen.getByRole('link', { name: en.accountingPage.summary.fixInSettings })
    expect(fix).toHaveAttribute('href', '/settings')
    // The one action that resolves the state is the primary one (#2869 design review).
    expect(fix.className).toContain('bg-[var(--v2-brand)]')
  })

  it('connected: the pointer to Settings is a ghost link, not a call to action', () => {
    renderSummary()
    const open = screen.getByRole('link', { name: en.accountingPage.openSettings })
    expect(open.className).not.toContain('bg-[var(--v2-brand)]')
  })

  it('scope_missing names the missing scopes as human labels', () => {
    renderSummary({
      destination: destination('scope_missing'),
      connected: false,
      companyName: null,
      missingScopes: ['companyinformation', 'archive'],
    })
    expect(screen.getByText(/\(company information, archive\)/)).toBeInTheDocument()
    expect(screen.queryByText(/companyinformation/)).toBeNull()
  })

  it('scope_missing with no named scopes uses the unnamed sentence, never "()"', () => {
    renderSummary({ destination: destination('scope_missing'), connected: false, missingScopes: [] })
    expect(screen.getByText(en.settings.accounting.detail.scopeMissingUnnamed('Fortnox'))).toBeInTheDocument()
    expect(screen.getByTestId('feed-summary').textContent).not.toContain('()')
  })

  it('no destination at all: not connected, pointing at Settings, with no connect control here', () => {
    renderSummary({ destination: null, connected: false, companyName: null })
    const line = screen.getByTestId('feed-summary')
    expect(line).toHaveAttribute('data-status', 'disconnected')
    expect(screen.getByText(en.accountingPage.summary.notConnected)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: en.accountingPage.openSettings })).toHaveAttribute('href', '/settings')
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
    // "Settings" once in the line and once on the action — not a third time
    // as a detail (#2869 design review).
    expect(screen.queryByText(en.accountingPage.manageInSettings)).toBeNull()
    expect((line.textContent?.match(/Settings/g) ?? []).length).toBe(2)
  })
})

describe('relativeTime', () => {
  const base = Date.parse('2026-09-12T10:00:00.000Z')
  it('reads as a past time in coarse units', () => {
    expect(relativeTime('2026-09-12T09:58:00.000Z', 'en', base)).toMatch(/2 minutes ago/)
    expect(relativeTime('2026-09-12T07:00:00.000Z', 'en', base)).toMatch(/3 hours ago/)
    expect(relativeTime('2026-09-10T10:00:00.000Z', 'en', base)).toMatch(/2 days ago/)
  })
  // #2926 removed the Swedish catalog, so there is no second locale to
  // contrast with. What stays worth pinning is that the tag comes from
  // INTL_LOCALE rather than being hard-coded at the Intl call: 'en-GB' is
  // day-month, which is the format the rest of the app reads in.
  it('formats through the locale-to-BCP-47 map, not a literal', () => {
    expect(INTL_LOCALE.en).toBe('en-GB')
    expect(relativeTime('2026-09-12T09:58:00.000Z', 'en', base)).toBe(
      new Intl.RelativeTimeFormat(INTL_LOCALE.en, { numeric: 'auto' }).format(-2, 'minute'),
    )
  })
})
