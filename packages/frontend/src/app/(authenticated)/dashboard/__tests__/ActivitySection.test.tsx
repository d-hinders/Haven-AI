import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiSchema } from '@haven_ai/core'
import { ActivitySection, activityDayLabel } from '../ActivitySection'

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

  it('shows "≈" when the group is a serve-time approximation', () => {
    renderSection({ activity: [group()] })

    expect(screen.getByText('≈')).toBeInTheDocument()
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

  it('shows the agent as the subtitle with one account, and drops "From My account"', () => {
    renderSection({ activity: [group()], accountCount: 1 })

    expect(screen.getByText('Research assistant')).toBeInTheDocument()
    expect(screen.queryByText('From My account')).not.toBeInTheDocument()
  })

  it('adds "From My account" only when there is more than one account', () => {
    renderSection({ activity: [group()], accountCount: 2 })

    expect(
      screen.getByText((_, element) => element?.textContent === 'Research assistant · From My account'),
    ).toBeInTheDocument()
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

describe('activityDayLabel', () => {
  it('names today and yesterday, and formats older days as a short date', () => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const lastWeek = new Date(today)
    lastWeek.setDate(today.getDate() - 7)

    expect(activityDayLabel(formatDayKey(today))).toBe('Today')
    expect(activityDayLabel(formatDayKey(yesterday))).toBe('Yesterday')
    expect(activityDayLabel(formatDayKey(lastWeek))).toMatch(/^\d{1,2} \w+$/)
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
