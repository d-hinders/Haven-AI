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

/** The populated figures with an EMPTY ledger: `refusals_recorded_from: null`
 *  is what the endpoint sends when payment_refusals has no rows at all —
 *  distinct from any day value, so the page can refuse to name a floor it was
 *  not given. */
const NO_FLOOR: AnalyticsOverviewResponse = {
  ...POPULATED,
  basis: { ...POPULATED.basis, refusals_recorded_from: null },
}

function settled(overrides: Record<string, unknown> = {}) {
  return { data: POPULATED, loading: false, failed: false, refetch: mockRefetch, ...overrides }
}

function preferences(currency: 'USD' | 'EUR' | 'SEK' = 'USD') {
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

  it('stacks the range control under the title below `sm` rather than beside it', () => {
    // The header primitive marks its actions beside the title ONLY for a
    // single icon-only control (`inlineActions`); for a row of labelled
    // buttons — the three-way range control — the default variant stacks it
    // below `sm`, because a forced row starves the `min-w-0` title column:
    // the capture harness proved this at 390px, where the heading resolved to
    // zero width and every mobile scenario refused to wait for it. jsdom runs
    // no media queries, so the visible proof is the capture; the structural
    // pin that the primitive is in its stacking form is this class list.
    render(<AnalyticsClient />)
    const header = screen.getByTestId('analytics-page').querySelector('header') as HTMLElement
    expect(header.className).toContain('flex-col')
    expect(header.className).toContain('sm:flex-row')
    // A bare `flex-row` (no `sm:` prefix) at base is the forced-row variant,
    // and it is the exact regression this pin exists to catch.
    expect(header.className.split(/\s+/)).not.toContain('flex-row')
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
    // Four tile placeholders over one table frame: the skeleton is the settled
    // page's block structure, not a spinner, which is what stops the layout
    // collapsing downward while the figures arrive.
    expect(skeleton.children.length).toBe(2)
    expect(skeleton.children[0].children.length).toBe(4) // the four tiles
    expect(skeleton.children[1].children.length).toBe(4) // header bar plus three rows
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
    // the runtime refused on its own never reached this ledger. The hosted
    // prepare-time budget refusal is NOT named any more — #3109 gave it a
    // writer (`source: 'hosted_prepare'`) so the tile counts it, and the
    // footnote must not tell the reader those rows do not exist (#3055 revert).
    // Since #3204 the caveat lives ONCE under the grid, not on the tile: the
    // tile keeps its own basis (count, attempts, amount) and stays the height
    // of its neighbours. Mutation: join the caveat back into the tile → red.
    const caveats = screen.getByTestId('analytics-refusal-caveats')
    expect(caveats.textContent).toMatch(/Price-cap refusals in your agent's runtime are not recorded\./)
    expect(tile.textContent).not.toMatch(/Price-cap refusals/)
    expect(caveats.textContent).not.toMatch(/hosted tools/)
    expect(caveats.textContent).not.toMatch(/prepare a purchase/)
    // The phrasing the issue retires: the quote tools quote and refuse
    // nothing, so a footnote that blames the quote describes a refusal no
    // code path raises.
    expect(caveats.textContent).not.toMatch(/quote/i)
    expect(tile.textContent).not.toMatch(/quote/i)
  })

  it('names the ledger floor when the endpoint reports one, and stays silent when it does not (#3013)', () => {
    // The populated fixture carries `refusals_recorded_from: '2026-05-28'`:
    // the renderer formats it (en-GB day + short month) and the clause sits
    // in the page-level caveat line under the tile grid (#3204) — the count
    // on the tile stays the truth for the part of the window the ledger
    // covers. The expected label below is the same expression the production
    // formatter uses, so this pin follows the formatter rather than restating it.
    render(<AnalyticsClient />)
    const caveats = screen.getByTestId('analytics-refusal-caveats')
    const expected = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
      new Date('2026-05-28'),
    )
    expect(caveats.textContent).toMatch(new RegExp(`Refusals are recorded from ${expected}\\.`))
  })

  it('renders NO floor line from a null `refusals_recorded_from` — an empty ledger names no day', () => {
    mockUseAnalyticsOverview.mockReturnValue(settled({ data: NO_FLOOR }))
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-refused')
    const caveats = screen.getByTestId('analytics-refusal-caveats')
    expect(caveats.textContent).not.toMatch(/Refusals are recorded from/)
    // The rest of the refusal sentence stays: the count and the one
    // unrecorded class are independent of the ledger floor — an empty ledger
    // does not make the path the page cannot see any more visible (#3055).
    expect(tile.textContent).toMatch(/2 refused payments/)
    expect(caveats.textContent).toMatch(/Price-cap refusals in your agent's runtime are not recorded\./)
    expect(caveats.textContent).not.toMatch(/hosted tools/)
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

  it('mounts the spend chart off the same response, below the agents table and above merchants (#3051; recipe item 5)', () => {
    render(<AnalyticsClient />)
    const spend = screen.getByTestId('analytics-spend-section')
    expect(within(spend).getByRole('heading', { name: 'Spend over time' })).toBeTruthy()
    // Desktop + narrow: the same complementary pair the balance section keeps.
    expect(within(spend).getAllByTestId('stacked-bar-chart')).toHaveLength(2)
    // Four fixture days, two with refusals: two marker caps per rendering.
    expect(within(spend).getAllByTestId('chart-refusal-marker')).toHaveLength(4)
    // Order: table, then the chart, then merchants — the table is the first
    // screen's reading surface (screen-recipes.md § Analytics, item 5).
    const table = screen.getByTestId('analytics-agents-section')
    const merchants = screen.getByTestId('analytics-merchants-section')
    expect(table.compareDocumentPosition(spend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(spend.compareDocumentPosition(merchants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the trend figures and the agents table once there are three days of data', () => {
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-sparse-line')).toBeNull()
    // Desktop table and mobile rows: the AgentsTable's complementary pair,
    // both present in the DOM — the two-renderings rule at the page level.
    // Scoped to the agents section because the merchants roster names the
    // same agents on purpose (one roster, both tables), so a page-wide count
    // of a name would be counting four renderings of one truth.
    const agentsSection = screen.getByTestId('analytics-agents-section')
    expect(within(agentsSection).getAllByText('Research agent')).toHaveLength(2)
    expect(within(agentsSection).getAllByText('Data-feed agent')).toHaveLength(2)
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
    expect(within(page).queryByTestId('analytics-spend-section')).toBeNull()
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

  it('sends sek on the wire for a SEK preference and renders sv-SE figures in the tiles (#3127)', () => {
    // SEK is the served default and the currency no user could previously
    // select; the tile must show the endpoint's figure in the currency's own
    // locale voice — "324,75 kr", never a USD figure relabelled "kr".
    preferences('SEK')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'sek')
    const tile = screen.getByTestId('stat-tile-spent')
    expect(tile.textContent).toContain('324,75\u00a0kr')
    expect(tile.textContent).not.toContain('$')
    expect(tile.textContent).not.toContain('€')
  })
})

/**
 * ── Slice E (#2949): the two sections the wire contract parked here ───────
 *
 * `MerchantsTable` and the balance-over-time chart, mounted. What the page
 * is under test for is the GUARDING, not the internals of either component —
 * those suites pin their own behaviour (`MerchantsTable.test.tsx` owns the
 * table's columns, the label rule and the link target; the chart's own
 * primitives are pinned at their homes in the design system). What belongs to
 * the page is the question of WHEN each section appears, and that question
 * has one answer with three parts:
 *
 *   1. one request owns the whole page — every figure below is read off the
 *      same `data` the tiles were rendered from, and the hook is asked
* exactly once;
 *   2. a section appears when ITS OWN array is populated: an endpoint that
 *      reported no merchants gets no table, and a balance series shorter
 *      than the chartable floor gets no chart — either rendered anyway would
 *      be the page asserting a figure it was not given;
 *   3. the sparse branch still withholds BOTH bands together, which is the
 *      point those bands were created for.
 *
 * The fixtures are the capture harness's again, imported and not re-typed —
 * the same bytes `screenshot.mjs` serves under `/analytics/overview` for the
 * `analytics-*` captures. The balance series is the 30 absolute snapshots
 * ending on the dashboard's own account total, so this suite and the PNGs
 * describe one endpoint.
 */
import {
  FIXTURE_ANALYTICS_BALANCE_BY_DAY,
  FIXTURE_ANALYTICS_MERCHANTS,
} from '../../../../../scripts/screenshot.mjs'
import { formatAnalyticsValue } from '@/lib/analytics-format'

const FIRST_SNAPSHOT = FIXTURE_ANALYTICS_BALANCE_BY_DAY[0]
const LAST_SNAPSHOT = FIXTURE_ANALYTICS_BALANCE_BY_DAY[FIXTURE_ANALYTICS_BALANCE_BY_DAY.length - 1]

/** Derived from the populated fixture, so the figures stay the harness's and
 *  only the array under test moves — the idiom of SPARSE above. */
const NO_MERCHANTS: AnalyticsOverviewResponse = { ...POPULATED, merchants: [] }
const SHORT_BALANCE: AnalyticsOverviewResponse = {
  ...POPULATED,
  balance_by_day: POPULATED.balance_by_day.slice(0, 2),
}
const LONGER_LAST: AnalyticsOverviewResponse = {
  ...POPULATED,
  balance_by_day: [...POPULATED.balance_by_day.slice(0, -1), { ...LAST_SNAPSHOT, value: '9999.00' }],
}

function settledWith(data: AnalyticsOverviewResponse) {
  return { data, loading: false, failed: false, refetch: mockRefetch }
}

describe('Analytics — the merchants and balance sections (slice E, #2949)', () => {
  it('mounts both sections off the one response the page already has', () => {
    // The whole point of slice B's single round-trip contract: the merchants
    // and the balance arrive on the same response as the tiles and the
    // agents, so mounting them must not spend a second request.
    render(<AnalyticsClient />)
    expect(screen.getByTestId('analytics-merchants-section')).toBeTruthy()
    expect(screen.getByTestId('analytics-balance-section')).toBeTruthy()
    expect(mockUseAnalyticsOverview).toHaveBeenCalledTimes(1)
  })

  it('lists the three harness merchants under a heading, in the endpoint’s order', () => {
    // The heading is what the capture harness waits on for the populated
    // scenario, so it is pinned at the page that renders it and not only at
    // the card that provides it. The order is the endpoint's ranking by
    // spend, which the page inherits rather than re-sorts.
    render(<AnalyticsClient />)
    const page = screen.getByTestId('analytics-page')
    const heading = within(page).getByRole('heading', { level: 2, name: 'Top merchants' })
    expect(heading).toBeTruthy()
    const rows = Array.from(
      screen.getByTestId('analytics-merchants-section').querySelectorAll('tbody tr'),
    )
    expect(rows.map((row) => row.querySelectorAll('td')[0].textContent)).toEqual([
      FIXTURE_ANALYTICS_MERCHANTS[0].label,
      FIXTURE_ANALYTICS_MERCHANTS[1].label,
      // The third label IS its address, and the table's one shared rule
      // truncates it — the full string rides on in the title.
      '0x71C2…7128',
    ])
  })

  it('renders the chart’s accessible name from the wire rows, not from a typed sentence', () => {
    // The summary is computed from the very series it draws (#2948's
    // precedent, which `BalanceSection` follows): a sentence typed next to
    // the data can drift from it. So the two figures the label states must
    // be the first and last snapshot of THIS response, formatted by the
    // voice the tiles use — and moving the last snapshot on the wire moves
    // the sentence with it.
    render(<AnalyticsClient />)
    const svg = screen.getByTestId('analytics-balance-section').querySelector('svg[role="img"]')
    const label = svg?.getAttribute('aria-label') ?? ''
    expect(label).toMatch(/^Balance over 30 days:/)
    expect(label).toContain(`started at ${formatAnalyticsValue(Number(FIRST_SNAPSHOT.value), 'USD')}`)
    expect(label).toContain(`ended at ${formatAnalyticsValue(Number(LAST_SNAPSHOT.value), 'USD')}`)
  })

  it('follows the wire: change the last snapshot and the summary sentence changes', () => {
    mockUseAnalyticsOverview.mockReturnValue(settledWith(LONGER_LAST))
    render(<AnalyticsClient />)
    const svg = screen.getByTestId('analytics-balance-section').querySelector('svg[role="img"]')
    expect(svg?.getAttribute('aria-label')).toContain(
      `ended at ${formatAnalyticsValue(9_999, 'USD')}`,
    )
  })

  it('speaks the chart in the currency the Settings surface owns, as it speaks the tiles', () => {
    // One preference, two sections: the chart must not hold a dollar while
    // the tile spends a euro, which is why both take `currency` from the
    // page and neither reads the response's own echo of it.
    preferences('EUR')
    render(<AnalyticsClient />)
    const svg = screen.getByTestId('analytics-balance-section').querySelector('svg[role="img"]')
    const label = svg?.getAttribute('aria-label') ?? ''
    expect(label).toContain(formatAnalyticsValue(Number(LAST_SNAPSHOT.value), 'EUR'))
    expect(label).not.toContain('$')
  })

  it('hands the chart the two-renderings pair, so a phone gets a narrower plot and not a second request', () => {
    const { container } = render(<AnalyticsClient />)
    const section = container.querySelector('[data-testid="analytics-balance-section"]') as HTMLElement
    const charts = Array.from(section.querySelectorAll('[data-testid="area-chart"]'))
    expect(charts).toHaveLength(2)
    const wrappers = charts.map((el) => el.parentElement?.className ?? '')
    expect(wrappers.some((c) => c.includes('hidden') && c.includes('lg:block'))).toBe(true)
    expect(wrappers.some((c) => c.includes('lg:hidden'))).toBe(true)
  })

  it('withholds the merchants table when the endpoint reported no merchant', () => {
    // An empty list renders no rows and, at the page, no table either: the
    // frame would be the component asserting a section the response did not
    // populate. The agents table and the chart are not moved — a range can
    // have agents and snapshots without a single resolved merchant.
    mockUseAnalyticsOverview.mockReturnValue(settledWith(NO_MERCHANTS))
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByText('Top merchants')).toBeNull()
    expect(screen.getByTestId('analytics-balance-section')).toBeTruthy()
    const agentsSection = screen.getByTestId('analytics-agents-section')
    expect(within(agentsSection).getAllByText('Research agent')).toHaveLength(2)
  })

  it('withholds the chart when the balance series is shorter than the chartable floor', () => {
    // Two snapshots are not a trend: a line through two points agrees with
    // every trend whatsoever and proves none of them, and the floor is the
    // chart system's own constant, imported here rather than restated. The
    // merchants table stands — it reports rows, not a shape, and two days
    // of it are as true as thirty.
    mockUseAnalyticsOverview.mockReturnValue(settledWith(SHORT_BALANCE))
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
    expect(screen.getByTestId('analytics-merchants-section')).toBeTruthy()
  })

  it('withholds both bands together while the window is sparse', () => {
    // The sparse branch returns before either section is reached, so a
    // two-day window reports the reason on the face of the page instead of
    // leaving a chart region and a table region to be diagnosed as bugs.
    mockUseAnalyticsOverview.mockReturnValue({
      data: SPARSE,
      loading: false,
      failed: false,
      refetch: mockRefetch,
    })
    render(<AnalyticsClient />)
    expect(screen.getByTestId('analytics-sparse-line')).toBeTruthy()
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
  })

  it('renders neither section in the empty window, where the page answers with its own state', () => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: EMPTY,
      loading: false,
      failed: false,
      refetch: mockRefetch,
    })
    const { container } = render(<AnalyticsClient />)
    expect(container.textContent).toMatch(/No agent activity in this range/)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
  })

  it('renders neither section on a failed request, which is an error and not an absence', () => {
    // The distinction slice C made and slice E must keep: an outage does not
    // report zero merchants, and a zero-looking page of figures would be the
    // most dangerous screenshot the product has ever rendered.
    mockUseAnalyticsOverview.mockReturnValue({
      data: null,
      loading: false,
      failed: true,
      refetch: mockRefetch,
    })
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('reports money and never savings, in the two sections as in the tiles', () => {
    // The copy doctrine of the epic, asserted over the whole page rather
    // than over one component, because a banned word in any one of the
    // sections is a page-wide failure.
    render(<AnalyticsClient />)
    const page = screen.getByTestId('analytics-page').textContent ?? ''
    expect(page).not.toMatch(/\bsavings\b/i)
    expect(page).not.toMatch(/\bwallet\b/i)
  })
})
