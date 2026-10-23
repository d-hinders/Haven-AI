import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSchema } from '@haven_ai/core'
import { ActivitySection } from '../ActivitySection'
import { transactionDayKey, transactionDayLabel } from '@/components/haven'

type ActivityGroup = ApiSchema<'DashboardActivityGroup'>

/**
 * The counterparty fields mirror the e2e fixture's group (#3824): one
 * confirmed x402 payment to an address with no resolved name, so the raw
 * address is the only thing a naive renderer would show.
 */
const MERCHANT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

function group(overrides: Partial<ActivityGroup> = {}): ActivityGroup {
  return {
    count: 1,
    sumAtomic: '12500000',
    tokenSymbol: 'USDC',
    decimals: 6,
    latestAt: new Date().toISOString(),
    agentId: 'agent-1',
    agentName: 'Research assistant',
    source: 'x402',
    x402ResourceUrl: 'https://research.example/report',
    to: MERCHANT,
    merchantName: null,
    activityType: null,
    direction: 'out',
    status: 'confirmed',
    approxAmount: '134.5000',
    approxCurrency: 'SEK',
    ...overrides,
  }
}

function renderSection(overrides: Partial<Parameters<typeof ActivitySection>[0]> = {}) {
  return render(
    <ActivitySection
      activity={[]}
      accountCount={1}
      hasAccounts
      loading={false}
      unavailable={false}
      onRetry={() => {}}
      {...overrides}
    />,
  )
}

describe('ActivitySection badges only when something is off (#3897)', () => {
  it('a confirmed row carries no status badge, in either direction', () => {
    renderSection({
      activity: [group(), group({ direction: 'in', agentId: 'agent-2', latestAt: new Date(Date.now() - 60_000).toISOString() })],
    })
    expect(screen.queryByText('Sent')).not.toBeInTheDocument()
    expect(screen.queryByText('Received')).not.toBeInTheDocument()
  })

  it('pending and failed rows keep theirs', () => {
    renderSection({
      activity: [
        group({ status: 'pending' }),
        group({ status: 'failed', agentId: 'agent-2', latestAt: new Date(Date.now() - 60_000).toISOString() }),
      ],
    })
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('a sub-cent amount reads 4 decimals, never "0,00"', () => {
    renderSection({ activity: [group({ approxAmount: '0.0040' })] })
    expect(screen.getByText(/-0,0040/)).toBeInTheDocument()
  })
})

describe('ActivitySection (#3810)', () => {
  it('renders one "×40" row for a group of 40, titled by the merchant site', () => {
    renderSection({ activity: [group({ count: 40, sumAtomic: '500000000' })] })

    expect(screen.getByText('×40')).toBeInTheDocument()
    expect(screen.getByText('research.example')).toBeInTheDocument()
    // The raw merchant address never surfaces.
    expect(screen.queryByText(MERCHANT)).not.toBeInTheDocument()
  })

  it('renders "×40+" when the count is a floor over a truncated window', () => {
    renderSection({ activity: [group({ count: 40, countIsFloor: true })] })

    expect(screen.getByText('×40+')).toBeInTheDocument()
  })

  it('a list row carries no "≈", even for a serve-time SEK approximation (#3950, #4165)', () => {
    renderSection({ activity: [group()] })

    expect(screen.queryByText(/≈/)).not.toBeInTheDocument()
    // The serve-time figure still renders, plain, in its own currency — the
    // mark belongs to totals and the detail panel, never to a row.
    expect(
      screen.getAllByText((_, element) =>
        (element?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/^[-+]/, '') === '134,50 kr',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('separates same-day rows with the inset hairline; a day\u2019s first row has none (#4165)', () => {
    // Local noon, so a run near midnight cannot split "today" in two.
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    const { container } = renderSection({
      activity: [
        group({ latestAt: today.toISOString() }),
        group({ latestAt: new Date(today.getTime() - 1000).toISOString(), agentId: 'agent-2' }),
        group({ latestAt: yesterday.toISOString(), agentId: 'agent-3' }),
      ],
    })
    const dividers = Array.from(container.querySelectorAll('[data-inset-divider]'))
    // Today has two rows (one hairline between them); yesterday has one (none).
    expect(dividers).toHaveLength(1)
    expect(dividers[0].className).toContain('before:bg-[var(--v2-border-subtle)]')
    // Day groups keep their full-width separation.
    expect(container.querySelector('.divide-y.divide-\\[var\\(--v2-border\\)\\]')).not.toBeNull()
  })

  it('shows no "≈" when every member carried book-time fiat', () => {
    renderSection({
      activity: [
        group({ approxAmount: undefined, convertedAmount: '134.5000', convertedCurrency: 'SEK' }),
      ],
    })

    expect(screen.queryByText('≈')).not.toBeInTheDocument()
    // The plain book-time figure renders in the preference currency (sv-SE
    // separates the suffix with an NBSP; the row's outbound sign rides in
    // front — matched on normalized text).
    expect(
      screen.getAllByText((_, element) =>
        (element?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/^[-+]/, '') === '134,50 kr',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('renders an unknown valuation as the em dash, never 0', () => {
    renderSection({ activity: [group({ approxAmount: null })] })

    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('names a sweep "Returned from <agent>"', () => {
    renderSection({
      activity: [
        group({
          source: null,
          x402ResourceUrl: null,
          activityType: 'delegate_sweep',
          direction: 'in',
          status: 'confirmed',
          to: '0x1111111111111111111111111111111111111111',
        }),
      ],
    })

    expect(screen.getByText('Returned from Research assistant')).toBeInTheDocument()
  })

  it('reads "Agent payment" for an x402 group with no resource URL', () => {
    renderSection({ activity: [group({ x402ResourceUrl: null })] })

    expect(screen.getByText('Agent payment')).toBeInTheDocument()
    expect(screen.queryByText(MERCHANT)).not.toBeInTheDocument()
  })

  it('reads "New recipient" for an unresolved counterparty — never the raw address', () => {
    renderSection({
      activity: [group({ source: null, x402ResourceUrl: null })],
    })

    expect(screen.getByText('New recipient')).toBeInTheDocument()
    expect(screen.queryByText(MERCHANT)).not.toBeInTheDocument()
  })

  it('uses the server-resolved merchant name as the title', () => {
    // The merchant name resolves the counterparty ADDRESS — an x402 group
    // keeps its resource hostname (the sharper identity), so this is a
    // non-x402 outbound group.
    renderSection({
      activity: [group({ source: null, x402ResourceUrl: null, merchantName: 'Acme Ltd' })],
    })

    expect(screen.getByText('Acme Ltd')).toBeInTheDocument()
  })

  it('#4099: a transfer in from another own account is titled "From <account>", not "Deposit"', () => {
    const inbound = { direction: 'in' as const, agentId: null, agentName: null, source: null, x402ResourceUrl: null }
    renderSection({
      accountCount: 2,
      activity: [
        group({ ...inbound, merchantName: 'Savings' }),
        group({ ...inbound, merchantName: null, latestAt: new Date(Date.now() - 60_000).toISOString() }),
      ],
    })

    expect(screen.getByText('From Savings')).toBeInTheDocument()
    expect(screen.queryByText('Savings', { exact: true })).not.toBeInTheDocument()
    // Every other deposit keeps the generic word.
    expect(screen.getByText('Deposit')).toBeInTheDocument()
    expect(screen.queryByText(MERCHANT)).not.toBeInTheDocument()
  })

  it('shows the agent as the subtitle with one account, and drops the "From <account>" half', () => {
    renderSection({ activity: [group({ fromAccountName: 'Savings' })], accountCount: 1 })

    expect(
      screen.getByText((_, element) => element?.textContent === 'Research assistant'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/From/)).not.toBeInTheDocument()
  })

  it('adds "From <account>" with the account the money left, only when there is more than one account (#4117)', () => {
    renderSection({ activity: [group({ fromAccountName: 'Savings' })], accountCount: 2 })

    expect(
      screen.getByText((_, element) => element?.textContent === 'Research assistant · From Savings'),
    ).toBeInTheDocument()
  })

  it('names the sending account on a send between two own accounts, never a fixed sender label (#4117)', () => {
    // Savings → the default "My account": the title is the receiving account,
    // the subtitle the one the money left.
    renderSection({
      activity: [
        group({
          agentId: null,
          agentName: null,
          source: null,
          x402ResourceUrl: null,
          merchantName: 'My account',
          fromAccountName: 'Savings',
        }),
      ],
      accountCount: 2,
    })

    expect(screen.getByText('My account')).toBeInTheDocument()
    // Exact: the subtitle is the sender alone, so no other "From …" can ride it.
    expect(screen.getByText((_, element) => element?.textContent === 'From Savings')).toBeInTheDocument()
    expect(screen.getAllByText(/^From /)).toHaveLength(1)
  })

  it('drops the "From" half when no sending-account name came back (an older backend)', () => {
    renderSection({ activity: [group()], accountCount: 2 })

    expect(
      screen.getByText((_, element) => element?.textContent === 'Research assistant'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/From/)).not.toBeInTheDocument()
  })

  it('groups rows under a shared day heading', () => {
    const morning = new Date()
    morning.setHours(1, 0, 0, 0)
    const evening = new Date()
    evening.setHours(22, 0, 0, 0)
    renderSection({
      activity: [
        group({ x402ResourceUrl: 'https://a.example/x', latestAt: morning.toISOString() }),
        group({ x402ResourceUrl: 'https://b.example/x', latestAt: evening.toISOString() }),
      ],
    })

    // Both rows sit under ONE heading — the server already grouped per
    // user-local day, so the client only names the bucket. Anchored so the
    // amounts ("50 kr") cannot read as a date.
    const headingPattern = /^(Today|Yesterday|\d{1,2} \w{3})$/
    expect(screen.getAllByText(headingPattern)).toHaveLength(1)
    expect(screen.getByText('a.example')).toBeInTheDocument()
    expect(screen.getByText('b.example')).toBeInTheDocument()
  })

  it('shows the empty state when there is no activity', () => {
    renderSection()

    expect(screen.getByText('No activity yet')).toBeInTheDocument()
    // #3944: the BODY copy is pinned too — the window variant replaces it,
    // so this is exactly what a signal-ABSENT response (an older backend, a
    // fixture without the field) must keep rendering.
    expect(
      screen.getByText('Receive funds or make your first payment to start building activity here.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open transactions' })).toHaveAttribute(
      'href',
      '/transactions',
    )
  })

  it('names the window when the feed only carries older activity (#3944)', () => {
    // QA user A: a deposit 13 days back, nothing since — an empty 7-day
    // list that "No activity yet" would misdescribe as a first-run account.
    renderSection({ hasOlderActivity: true, activityWindowDays: 7 })

    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
    expect(screen.getByText('No activity in the last 7 days')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Payments and deposits from before this window are still on your transactions page.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open transactions' })).toHaveAttribute(
      'href',
      '/transactions',
    )
  })

  it('keeps the "No activity yet" copy when the signal is present but false', () => {
    renderSection({ hasOlderActivity: false, activityWindowDays: 7 })

    expect(screen.getByText('No activity yet')).toBeInTheDocument()
    expect(screen.queryByText('No activity in the last 7 days')).not.toBeInTheDocument()
  })

  it('labels pending and failed groups without faking a direction', () => {
    renderSection({
      activity: [
        group({ status: 'pending' }),
        group({ status: 'failed', x402ResourceUrl: 'https://b.example/x' }),
      ],
    })

    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })
})

describe('ActivitySection — a move between your own accounts (#4268)', () => {
  // The backend folds both legs into one out group carrying `ownTransfer`;
  // `merchantName` / `fromAccountName` stay populated for an older client.
  const move = (overrides: Partial<ActivityGroup> = {}) =>
    group({
      agentId: null,
      agentName: null,
      source: null,
      x402ResourceUrl: null,
      to: '0x2222222222222222222222222222222222222222',
      merchantName: 'Savings',
      fromAccountName: 'Main',
      ownTransfer: { fromAccountName: 'Main', toAccountName: 'Savings' },
      sumAtomic: '1000000',
      approxAmount: '10.7600',
      ...overrides,
    })

  it('one row: the move title, the move mark, Main → Savings, an unsigned amount, no "From" subtitle', () => {
    const { container } = renderSection({ activity: [move()], accountCount: 2 })
    expect(screen.getByText('Moved between your accounts')).toBeInTheDocument()
    expect(container.querySelector('svg.lucide-arrow-left-right')).not.toBeNull()
    const subline = screen.getByText('Main').closest('span.inline-flex')
    // The arrow is aria-hidden; an sr-only "to" stands in for it.
    expect(subline?.textContent).toBe('Main→toSavings')
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument()
    const amount = container.querySelector('.v2-tabular')
    expect(amount?.textContent).not.toMatch(/^[-+−]/)
    expect(container.textContent).not.toMatch(/0x[0-9a-fA-F]{4}/)
  })

  it('a same-day ×2 move keeps the count label', () => {
    renderSection({ activity: [move({ count: 2, sumAtomic: '3000000' })], accountCount: 2 })
    expect(screen.getByText('×2')).toBeInTheDocument()
    expect(screen.getByText('Moved between your accounts')).toBeInTheDocument()
  })

  it('a group without ownTransfer still reads as the send it is (an older backend)', () => {
    renderSection({ activity: [move({ ownTransfer: undefined })], accountCount: 2 })
    expect(screen.queryByText('Moved between your accounts')).not.toBeInTheDocument()
    expect(screen.getByText('Savings')).toBeInTheDocument()
    expect(screen.getByText('From Main')).toBeInTheDocument()
  })
})

describe('the shared day helpers match the dropped local copies (#4225)', () => {
  // ActivitySection used to carry its own `localDayKey` and `activityDayLabel`,
  // word-for-word copies of the ledger's `transactionDayKey` /
  // `transactionDayLabel`. The section now uses the shared helpers directly;
  // this pins that their output is exactly what the local copies produced,
  // so the swap cannot change a rendered heading. "(partial)" rides on top
  // of the label and is pinned in the partial describe below.
  it('transactionDayKey keys the local day; transactionDayLabel names it', () => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const lastWeek = new Date(today)
    lastWeek.setDate(today.getDate() - 7)

    // The dropped `localDayKey`: the en-CA `YYYY-MM-DD` key.
    const formatDayKey = (date: Date) => transactionDayKey(date.toISOString())
    expect(formatDayKey(today)).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // The dropped `activityDayLabel`: today, yesterday, then en-GB short date.
    expect(transactionDayLabel(formatDayKey(today))).toBe('Today')
    expect(transactionDayLabel(formatDayKey(yesterday))).toBe('Yesterday')
    expect(transactionDayLabel(formatDayKey(lastWeek))).toMatch(/^\d{1,2} \w+$/)
  })

  it('bands the second and later days, keeping the first day plain under the Card.Header (#4225)', () => {
    const morning = new Date()
    morning.setHours(1, 0, 0, 0)
    const twoDaysAgo = new Date(morning.getTime() - 2 * 24 * 60 * 60 * 1000)
    renderSection({
      activity: [
        group({ x402ResourceUrl: 'https://a.example/x', latestAt: morning.toISOString() }),
        group({ x402ResourceUrl: 'https://b.example/x', latestAt: twoDaysAgo.toISOString() }),
      ],
    })

    const headingPattern = /^(Today|Yesterday|\d{1,2} \w{3})$/
    const headings = screen.getAllByText(headingPattern)
    expect(headings).toHaveLength(2)
    // First day: plain label — the Activity card's own tinted Card.Header
    // sits directly above, so two bands of one tint never stack.
    expect(headings[0].className).not.toContain('bg-[var(--v2-table-header-bg)]')
    expect(headings[0].className).toContain('text-[var(--v2-ink-3)]')
    // Later days: the tinted day band, on the table-header tokens.
    expect(headings[1].className).toContain('bg-[var(--v2-table-header-bg)]')
    expect(headings[1].className).toContain('text-[var(--v2-table-header-ink)]')
    expect(headings[1].className).toContain('border-b')
    expect(headings[1].className).toContain('uppercase')
    // Uppercase is CSS-only — the DOM text stays matchable.
    expect(headings[1].textContent).toMatch(headingPattern)
  })

  it('keeps the single-day preview plain first-day label (the kept Card.Header owns the tint)', () => {
    renderSection({ activity: [group()] })
    // With one day, the band is skipped entirely — the Activity card's own
    // tinted Card.Header sits directly above, and the heading keeps the
    // pre-#4225 plain-label styling via band={false}.
    const heading = screen.getAllByText(/^(Today|Yesterday|\d{1,2} \w{3})$/)
    expect(heading).toHaveLength(1)
    expect(heading[0].tagName).toBe('P')
    expect(heading[0].className).toContain('text-[var(--v2-ink-3)]')
    expect(heading[0].className).not.toContain('bg-[var(--v2-table-header-bg)]')
  })
})

// #3975: the rolling window starts at an instant, not at a local midnight,
// so its oldest day heading can cover part of a day — and says so, following
// the analytics precedent. Pinned on a frozen clock so the day labels (and
// the exact strings) cannot drift with the wall clock the suite runs at.
describe('the partial oldest day heading (#3975)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Freeze the clock at the issue's observed instant (09:12 Stockholm). */
  function freezeAtObservedInstant() {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T07:12:00Z'))
  }

  /** The fixture's two groups: one yesterday, one on the window-start day. */
  function observedRows() {
    return [
      group({ latestAt: '2026-10-14T06:00:00.000Z', x402ResourceUrl: 'https://b.example/x' }),
      group({ latestAt: '2026-10-08T11:48:00.000Z' }),
    ]
  }

  it('marks the oldest day heading partial when the window start cuts its day', () => {
    freezeAtObservedInstant()
    renderSection({
      activity: observedRows(),
      activityWindowStart: '2026-10-08T07:12:00.000Z',
    })

    // The EXACT string, pinned: the short date plus the analytics wording.
    expect(screen.getByText('8 Oct (partial)')).toBeInTheDocument()
    // A day fully inside the window keeps its bare label.
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.queryByText('Yesterday (partial)')).not.toBeInTheDocument()
  })

  it('marks nothing when the window start sits on a local midnight', () => {
    freezeAtObservedInstant()
    // Local midnight of the runtime zone, seven days before the frozen now —
    // computed, not written, so the pin holds in every CI zone.
    const midnight = new Date('2026-10-15T07:12:00Z')
    midnight.setHours(0, 0, 0, 0)
    const windowStartAtMidnight = new Date(
      midnight.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString()
    renderSection({
      activity: observedRows(),
      activityWindowStart: windowStartAtMidnight,
    })

    expect(screen.getByText('8 Oct')).toBeInTheDocument()
    expect(screen.queryByText(/partial/)).not.toBeInTheDocument()
  })

  it('marks nothing when the signal is absent (an older backend)', () => {
    freezeAtObservedInstant()
    renderSection({ activity: observedRows() })

    expect(screen.getByText('8 Oct')).toBeInTheDocument()
    expect(screen.queryByText(/partial/)).not.toBeInTheDocument()
  })
})

/** The same en-CA key the section buckets by. */
function formatDayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
