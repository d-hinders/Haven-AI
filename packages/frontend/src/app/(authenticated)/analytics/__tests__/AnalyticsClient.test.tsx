import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

/**
 * The Analytics page's five states (#2947, slice C).
 *
 * What is under test is the MUTUAL EXCLUSION of those states, because that is
 * what the page's honesty rests on: the empty state reports "the endpoint
 * answered and the window holds nothing", the error state reports "it did not
 * answer", and a page of confident zeros is exactly what an outage is mistaken
 * for. Every pair of states therefore gets an assertion that the other one is
 * ABSENT, not merely that its own copy is present.
 *
 * The request itself is mocked at the hook seam (`useAnalyticsOverview`),
 * following `DashboardClient.test.tsx`'s idiom, so the five states can be
 * driven directly instead of through a timer and a fetch double-crossing. The
 * hook's own contract — one request per window, the superseded-response guard,
 * the `tz` parameter — is pinned in `hooks/__tests__/useAnalyticsOverview.test.ts`.
 *
 * The fixtures are the CAPTURE HARNESS's own constants, imported from
 * `scripts/screenshot.mjs` exactly as `screenshot-fixture.test.ts` does, rather
 * than re-typed here. That is deliberate and it is load-bearing: the harness
 * serves these bytes to the page under `/analytics/overview` in the
 * `analytics-*` captures, so the unit assertions and the rendered evidence
 * cannot describe two different endpoints. The parity of the fixture with slice
 * B's generated wire types is checked by `screenshot-fixture.test.ts`; the cast
 * below hands that guarantee over rather than restating it.
 */

const mockUsePreferences = vi.fn()
const mockUseAnalyticsOverview = vi.fn()
const mockRefetch = vi.fn()

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

vi.mock('@/hooks/useAnalyticsOverview', () => ({
  useAnalyticsOverview: (range: string, currency: string) => mockUseAnalyticsOverview(range, currency),
  // The real one is `by_day.length`; kept as the same expression so a change
  // to the sparse rule cannot pass here while failing there.
  analyticsDaysWithData: (data: { by_day?: unknown[] } | null) => data?.by_day?.length ?? 0,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import AnalyticsClient from '../AnalyticsClient'
import {
  FIXTURE_ANALYTICS_OVERVIEW,
  FIXTURE_ANALYTICS_OVERVIEW_EMPTY,
} from '../../../../../scripts/screenshot.mjs'
import type { AnalyticsOverviewResponse } from '@/types/analytics'
import { ANALYTICS_RANGE_STORAGE_KEY } from '@/lib/analytics-range'

// See the note above: the parity test owns the fixture's fidelity to the
// generated types, and this file's silence about it is not a gap.
const POPULATED = FIXTURE_ANALYTICS_OVERVIEW as AnalyticsOverviewResponse
const EMPTY = FIXTURE_ANALYTICS_OVERVIEW_EMPTY as AnalyticsOverviewResponse

/** The sparse case is DERIVED from the populated one, so its figures stay the
 *  ones the harness declares and only the day-count moves. */
const SPARSE: AnalyticsOverviewResponse = { ...POPULATED, by_day: POPULATED.by_day.slice(0, 2) }

function settled(overrides: Record<string, unknown> = {}) {
  return { data: POPULATED, loading: false, failed: false, refetch: mockRefetch, ...overrides }
}

function preferences(currency: 'USD' | 'EUR' = 'USD') {
  mockUsePreferences.mockReturnValue({ currency, setCurrency: vi.fn(), saving: false })
}

beforeEach(() => {
  preferences()
  mockUseAnalyticsOverview.mockReset()
  mockRefetch.mockReset()
  mockUseAnalyticsOverview.mockReturnValue(settled())
})

describe('Analytics — the header the capture harness waits on', () => {
  it('renders the declared title and the subtitle that frames the whole page', () => {
    render(<AnalyticsClient />)
    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeTruthy()
    expect(screen.getByText('What your agents did with your money.')).toBeTruthy()
  })

  it('names the window the figures cover, from the response own range', () => {
    render(<AnalyticsClient />)
    // The caption is the endpoint's `range.days`, not the control's label, so
    // a server that resolved the request to a different window than the one
    // asked for is what the reader is told.
    expect(screen.getByText('Last 30 days')).toBeTruthy()
  })
})

describe('Analytics — loading', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({ data: null, loading: true, failed: false, refetch: mockRefetch })
  })

  it('is announced as a busy region that says what it is waiting for', () => {
    render(<AnalyticsClient />)
    const skeleton = screen.getByTestId('analytics-skeleton')
    expect(skeleton.getAttribute('role')).toBe('status')
    expect(skeleton.getAttribute('aria-busy')).toBe('true')
    expect(skeleton.getAttribute('aria-label')).toBe('Loading analytics')
  })

  it('renders nothing that asserts a figure while the request is in flight', () => {
    // The headless equivalent AGENTS.md asks for on a loading-state flash: the
    // gated content does not render while its prerequisite is loading. A tile
    // painted before the answer arrives is a number the endpoint never sent,
    // and the skeleton is the only thing standing in its place.
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-tiles')).toBeNull()
    expect(screen.queryByTestId('stat-tile-spent')).toBeNull()
    expect(screen.queryByTestId('stat-tile-refused')).toBeNull()
    expect(screen.queryByTestId('stat-tile-budget-used')).toBeNull()
    expect(screen.queryByTestId('stat-tile-fees-paid-to-haven')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
  })

  it('keeps the shape of the settled page while it waits, so nothing jumps when it fills', () => {
    // Four tile placeholders over one table placeholder: the skeleton is the
    // final layout, not a spinner, which is what stops the page collapsing
    // downward as the figures arrive.
    render(<AnalyticsClient />)
    const skeleton = screen.getByTestId('analytics-skeleton')
    expect(within(skeleton).getAllByRole('status', { hidden: true })).toBeTruthy()
    expect(skeleton.querySelectorAll('[class*="rounded-"]').length).toBeGreaterThan(4)
    expect(screen.getByText('Last 30 days')).toBeTruthy()
  })
})

describe('Analytics — failure', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({ data: null, loading: false, failed: true, refetch: mockRefetch })
  })

  it('reports the failure as an alert and says what did not load', () => {
    render(<AnalyticsClient />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('We could not load your analytics')).toBeTruthy()
  })

  it('does not let an outage read as a quiet window', () => {
    // The pair of the empty state's assertion below, and the reason the two
    // states are mutually exclusive: a page of zeros would be the outage's
    // most convincing disguise.
    render(<AnalyticsClient />)
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
    expect(screen.queryByTestId('analytics-tiles')).toBeNull()
    expect(screen.queryByTestId('analytics-skeleton')).toBeNull()
  })

  it('says the money has not stopped, because a reader may reasonably fear it has', () => {
    render(<AnalyticsClient />)
    expect(screen.getByText(/Your agents keep spending under the rules you set/)).toBeTruthy()
    expect(screen.getByText(/Nothing here moved or changed/)).toBeTruthy()
  })

  it('offers the one remedy it has evidence for, and hands it to the caller', async () => {
    render(<AnalyticsClient />)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mockRefetch).toHaveBeenCalledTimes(1)
  })

  it('echoes nothing of the failure back to the reader', () => {
    // The hook swallows the error and sets a flag; the page owns the copy. A
    // status code or a stack frame in this panel would be a claim about cause
    // the response did not make, and it teaches readers to copy it into a
    // support thread.
    render(<AnalyticsClient />)
    expect(screen.getByRole('alert').textContent).not.toMatch(/500|40[0-9]|TypeError|undefined/)
  })
})

describe('Analytics — the empty window', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: EMPTY,
      loading: false,
      failed: false,
      refetch: mockRefetch,
    })
  })

  it('says so in one sentence rather than in four tiles asserting zeros', () => {
    render(<AnalyticsClient />)
    expect(screen.getByText('No agent activity in this range')).toBeTruthy()
    expect(screen.getByTestId('analytics-page')).toBeTruthy()
    // The load-bearing half: the tiles are GONE. Four confident zeros in the
    // layout of a working page is the screen-shape an outage passes for free.
    expect(screen.queryByTestId('analytics-tiles')).toBeNull()
    expect(screen.queryByTestId('stat-tile-spent')).toBeNull()
  })

  it('is not an alert, because the endpoint did answer', () => {
    render(<AnalyticsClient />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('points at the two things the reader can still do', () => {
    render(<AnalyticsClient />)
    expect(screen.getByText(/A longer range may reach further back/)).toBeTruthy()
    expect(screen.getByText(/the Agents page shows what each agent is allowed to spend/)).toBeTruthy()
  })
})

describe('Analytics — the populated page', () => {
  it('renders the four figures the page answers with, in the order they are scanned', () => {
    render(<AnalyticsClient />)
    const tiles = screen.getByTestId('analytics-tiles')
    const labels = Array.from(tiles.querySelectorAll('[data-testid^="stat-tile-"]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(labels).toEqual([
      'stat-tile-spent',
      'stat-tile-refused',
      'stat-tile-budget-used',
      'stat-tile-fees-paid-to-haven',
    ])
  })

  it('renders the booked total with its basis underneath it', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-spent')
    expect(within(tile).getByText('$324.75')).toBeTruthy()
    // The clause that makes the total readable: what it counted, and what it
    // left out. A silently smaller total is indistinguishable from a total that
    // was always that size, so the exclusion is on the face of the tile.
    expect(tile.textContent).toMatch(/based on 5 payments/)
    expect(tile.textContent).toMatch(/1 awaiting settlement evidence is not counted/)
  })

  it('renders the refusals with the attempts behind them and the price of them', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-refused')
    expect(within(tile).getByText('2')).toBeTruthy()
    expect(tile.textContent).toMatch(/2 refused payments · across 3 attempts/)
    expect(tile.textContent).toMatch(/\$3\.00 attempted/)
    // The limit of the count, stated rather than left to be inferred: what
    // the runtime refused on its own never reached this ledger.
    expect(tile.textContent).toMatch(/Price-cap refusals in your agent/)
  })

  it('renders the budget bands as a count of agents over their own budgets', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-budget-used')
    expect(within(tile).getByText('1/2')).toBeTruthy()
    expect(tile.textContent).toMatch(/1 of 2 agents above 75% of their period budget/)
  })

  it('says the fee schedule in words when nothing is being charged', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-fees-paid-to-haven')
    // The one figure on this page that must NOT be a number: $0.00 here would
    // report "nothing charged in this window", which is a different fact from
    // "the product is not charging fees".
    expect(within(tile).getByText('No fees yet')).toBeTruthy()
    expect(tile.textContent).toMatch(/Haven is not charging fees/)
    // The free things the product did pay for, still reported while it is off.
    expect(tile.textContent).toMatch(/Haven sponsored 7 operations' gas/)
    expect(within(tile).queryByText(/^\+|^-/)).toBeNull()
  })

  it('shows the trend figures and the agents table once there are three days of data', () => {
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-sparse-line')).toBeNull()
    expect(within(screen.getByTestId('analytics-page')).getByText('Research agent')).toBeTruthy()
    expect(within(screen.getByTestId('analytics-page')).getByText('Data-feed agent')).toBeTruthy()
  })
})

describe('Analytics — the sparse window', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: SPARSE,
      loading: false,
      failed: false,
      refetch: mockRefetch,
    })
  })

  it('keeps the tiles and says on the face of the page what is missing', () => {
    // A total over two days is still the total over those two days, so the
    // figures stay. What goes is the trend: a line through two points agrees
    // with every trend whatsoever and proves none of them.
    render(<AnalyticsClient />)
    expect(screen.getByTestId('analytics-tiles')).toBeTruthy()
    expect(screen.getByTestId('analytics-sparse-line').textContent).toMatch(/at least three days of data/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
  })

  it('withholds the table along with the charts, rather than leaving a blank region to diagnose', () => {
    render(<AnalyticsClient />)
    const page = screen.getByTestId('analytics-page')
    expect(within(page).queryByText('Research agent')).toBeNull()
    expect(within(page).queryByText('Data-feed agent')).toBeNull()
  })
})

describe('Analytics — the window the reader chose', () => {
  it('asks for the stored window on the FIRST request, without asking for the default first', () => {
    // The headless proof of the initialiser-not-effect rule in
    // `lib/analytics-range.ts`: a device that chose 90d must not spend a
    // request on 30d to find out what it already knew, and must not flash the
    // wrong window for the frames before it settles. One call, and it carries
    // the stored value.
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '90d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenCalledTimes(1)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('90d', 'usd')
    expect(screen.getByText('Last 30 days')).toBeTruthy() // the response owns the caption
  })

  it('falls back to the default when nothing is stored', () => {
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd')
  })

  it('ignores a stored value the endpoint would answer 400 to, and still renders', () => {
    // One bad string in localStorage must not take the page into its error
    // state; the read is guarded and the request is the documented default.
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '180d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('remembers the window the reader picks, for this device', async () => {
    render(<AnalyticsClient />)
    const group = screen.getByRole('radiogroup', { name: 'Analytics date range' })
    await userEvent.click(within(group).getByRole('radio', { name: '7 days' }))
    expect(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)).toBe('7d')
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('7d', 'usd')
  })

  it('offers exactly the three windows the endpoint documents, and marks the chosen one', () => {
    render(<AnalyticsClient />)
    const group = screen.getByRole('radiogroup', { name: 'Analytics date range' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['7 days', '30 days', '90 days'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })
})

describe('Analytics — the currency is the one the Settings surface owns', () => {
  it('sends the preference on the wire and renders the same one in the tiles', () => {
    // The response also carries `currency`, and the page does not consult it:
    // were the two to disagree the reader would have two answers to "which
    // currency am I reading" and would believe the louder one. Both halves of
    // the page therefore come from `usePreferences`, from one reading.
    preferences('EUR')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'eur')
    const tile = screen.getByTestId('stat-tile-spent')
    expect(tile.textContent).toMatch(/324,75/)
    expect(tile.textContent).not.toContain('$')
  })

  it('renders USD when the preference is USD, so the two currencies are both covered', () => {
    preferences('USD')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd')
    expect(screen.getByTestId('stat-tile-spent').textContent).toMatch(/\$324\.75/)
  })
})
