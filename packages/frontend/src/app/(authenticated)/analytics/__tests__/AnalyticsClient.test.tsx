import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

/**
 * The Analytics page's states (#2947, slice C; the #4333 rebuild).
 *
 * What is under test is the MUTUAL EXCLUSION of those states, because that is
 * what the page's honesty rests on: the empty state reports "the endpoint
 * answered and the window holds nothing", the new-user state reports "there
 * is no agent the page could ever report on", the error state reports "it did
 * not answer", and a page of confident zeros is exactly what an outage is
 * mistaken for. Every pair of states therefore gets an assertion that the
 * other one is ABSENT, not merely that its own copy is present.
 *
 * Both hooks are mocked at their seam (`useAnalyticsOverview`,
 * `useAgents`), following `DashboardClient.test.tsx`'s idiom, so the states
 * can be driven directly instead of through a timer and a fetch
 * double-crossing. The request hook's own contract — one request per window,
 * the superseded-response guard, the `tz` parameter, the `agentId` path — is
 * pinned in `hooks/__tests__/useAnalyticsOverview.test.ts`.
 *
 * The fixtures are the CAPTURE HARNESS's own constants, imported from
 * `scripts/screenshot.mjs` exactly as `screenshot-fixture.test.ts` does,
 * rather than re-typed here. That is deliberate and it is load-bearing: the
 * harness serves these bytes to the page under `/analytics/overview` in the
 * `analytics-*` captures, so the unit assertions and the rendered evidence
 * cannot describe two different endpoints. The parity of the fixture with slice
 * B's generated wire types is checked by `screenshot-fixture.test.ts`; the cast
 * below hands that guarantee over rather than restating it.
 */

const mockUsePreferences = vi.fn()
const mockUseAnalyticsOverview = vi.fn()
const mockUseAgents = vi.fn()
const mockRefetch = vi.fn()

vi.mock('@/hooks/usePreferences', () => ({
  usePreferences: () => mockUsePreferences(),
}))

vi.mock('@/hooks/useAnalyticsOverview', () => ({
  useAnalyticsOverview: (range: string, currency: string, agentId: string | null) =>
    mockUseAnalyticsOverview(range, currency, agentId),
}))

vi.mock('@/hooks/useAgents', () => ({
  useAgents: () => mockUseAgents(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

// AgentsTable's whole-row link navigates via `useRouter`; jsdom has no app
// router to mount, so the router seam is stubbed — the row's navigation is
// the component's own concern (pinned in AgentsTable.test.tsx).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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

/** A populated window with payments but no refusals at all — a real production
 *  state (an account whose agents stayed inside every budget). */
const NO_REFUSALS: AnalyticsOverviewResponse = {
  ...POPULATED,
  totals: { ...POPULATED.totals, refused_count: 0, refused_attempts: 0, refused_amount: '0', refused_previous_count: 0 },
}

/** Fees ON: the fifth tile exists only while the flag is on (#4333). */
const FEES_ON: AnalyticsOverviewResponse = {
  ...POPULATED,
  totals: { ...POPULATED.totals, fees: { amount: '1.25', previous: '0', flag_on: true } },
}

function settled(overrides: Record<string, unknown> = {}) {
  return { data: POPULATED, loading: false, failed: false, agentNotFound: false, refetch: mockRefetch, ...overrides }
}

function preferences(currency: 'USD' | 'EUR' | 'SEK' = 'USD') {
  mockUsePreferences.mockReturnValue({ currency, setCurrency: vi.fn(), saving: false })
}

/** Two agents the list names — the facet's options and the new-user rule's
 *  counterexample. Not the harness's rows: this is the LIST's shape (Agent),
 *  and the overview fixture's rows are the response's. */
const AGENTS_LIST = [
  { id: 'agent-research', name: 'Research agent', status: 'active' as const },
  { id: 'agent-retired', name: 'Data-feed agent', status: 'revoked' as const },
]

function agentList(overrides: Partial<{ agents: typeof AGENTS_LIST; loading: boolean }> = {}) {
  return { agents: AGENTS_LIST, loading: false, error: null, refetch: vi.fn(), ...overrides }
}

beforeEach(() => {
  preferences()
  mockUseAnalyticsOverview.mockReset()
  mockRefetch.mockReset()
  mockUseAgents.mockReset()
  mockUseAnalyticsOverview.mockReturnValue(settled())
  mockUseAgents.mockReturnValue(agentList())
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

/** The facet's resting trigger: the list-controls chip, "Agent: All agents". */
function agentFacetTrigger() {
  return screen.getByRole('button', { name: 'Agent: All agents' })
}

describe('Analytics — the header the capture harness waits on', () => {
  it('renders the declared title and the subtitle that frames the whole page', () => {
    render(<AnalyticsClient />)
    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toBeTruthy()
    expect(screen.getByText('What your agents did with your money.')).toBeTruthy()
  })

  it('carries the Agent facet beside the PeriodPicker, and nothing else (#4333)', () => {
    // The mockup's header: the facet, the picker. The old window caption
    // ("Last 30 days" beside the picker) is gone — the trigger's own value
    // span is the ONE place the window is named.
    render(<AnalyticsClient />)
    expect(agentFacetTrigger()).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.getByRole('button', { name: 'Period: Last 30 days' })).toBeTruthy()
    // Exactly ONE element carries the window words, and it is inside the
    // trigger: the bare caption beside the picker did not survive #4333.
    const copies = screen.getAllByText('Last 30 days', { exact: true })
    expect(copies).toHaveLength(1)
    expect(copies[0].closest('button')).not.toBeNull()
  })

  it("hands both controls to PageHeader's own wrapping actions row, with no wrapper of its own (#4401)", () => {
    // A non-wrapping wrapper made the pair ONE unbreakable child, so at 390
    // the header ran 420 px wide. Each control's root must be a DIRECT child
    // of the row that wraps.
    render(<AnalyticsClient />)
    const header = screen.getByTestId('analytics-page').querySelector('header') as HTMLElement
    const row = header.lastElementChild as HTMLElement
    expect(row.className.split(/\s+/)).toContain('flex-wrap')
    const facetRoot = agentFacetTrigger().parentElement
    const periodRoot = screen.getByRole('button', { name: 'Period: Last 30 days' }).parentElement
    expect(facetRoot?.parentElement).toBe(row)
    expect(periodRoot?.parentElement).toBe(row)
    // Facet first, then Period (design-system § Analytics header).
    expect(Array.from(row.children)).toEqual([facetRoot, periodRoot])
  })

  it('stacks the range control under the title below `sm` rather than beside it', () => {
    render(<AnalyticsClient />)
    const header = screen.getByTestId('analytics-page').querySelector('header') as HTMLElement
    expect(header.className).toContain('flex-col')
    expect(header.className).toContain('sm:flex-row')
    expect(header.className.split(/\s+/)).not.toContain('flex-row')
  })

  it('offers the facet one option per agent on the LIST, All agents first, and collapses the unusable ones (#4453)', async () => {
    // Options come from `useAgents` — NOT the overview's filtered response —
    // so the facet cannot vanish the moment an agent is picked
    // (FacetMenu hides itself at one option or fewer).
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    const radios = screen.getAllByRole('menuitemradio')
    expect(radios.map((r) => r.textContent)).toEqual(['All agents', 'Research agent'])
    // The revoked agent is not gone: it sits behind the inactive group's
    // disclosure row, which names the count.
    const toggle = screen.getByRole('menuitem', { name: 'Show 1 inactive' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows each agent’s status in `meta` and the inactive group, from the shared builder (#4453)', async () => {
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())

    // An active agent carries no status suffix — "Active" is the resting state.
    const active = screen.getByRole('menuitemradio', { name: /Research agent/ })
    expect(active).toHaveTextContent('Research agent')
    expect(active).not.toHaveTextContent('Active')

    await user.click(screen.getByRole('menuitem', { name: 'Show 1 inactive' }))
    const revoked = screen.getByRole('menuitemradio', { name: /Data-feed agent/ })
    // The label is the name alone; the status is the non-truncating `meta` slot.
    expect(revoked).toHaveTextContent('Data-feed agent')
    expect(revoked).toHaveTextContent('Revoked')
  })

  it('writes ?agentId= and re-asks the overview with it when an agent is picked', async () => {
    // The key is the one /transactions reads, so an agent page's link to
    // /analytics?agentId=<id> and a facet pick land in the same place.
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    await user.click(screen.getByRole('menuitemradio', { name: 'Research agent' }))
    expect(window.location.search).toBe('?agentId=agent-research')
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', 'agent-research')
    // The trigger now names the agent: the facet is the one place the filter
    // is visible.
    expect(screen.getByRole('button', { name: 'Agent: Research agent' })).toBeTruthy()
  })

  it('clears a stale or foreign agentId with a one-line notice, not the page error (#4333)', () => {
    window.history.replaceState(null, '', '/analytics?agentId=agent-ghost')
    render(<AnalyticsClient />)
    // The list arrived and names no such agent: the filter is gone and the
    // reader is told, rather than shown the unfiltered page as if the link
    // had worked — and rather than an error state for a request that never
    // needed to fail.
    expect(screen.getByTestId('analytics-agent-notice').textContent).toMatch(/That agent isn't available/)
    // The first request carried the stale id; after the clear the page asks
    // once more WITHOUT it — the unfiltered report, announced by the notice.
    expect(mockUseAnalyticsOverview).toHaveBeenCalledWith('30d', 'usd', 'agent-ghost')
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', null)
    expect(window.location.search).not.toContain('agentId')
  })

  it('does not persist the agent filter in localStorage (#4333)', async () => {
    // The agent filter is linkable state, not a device preference: the range
    // keeps `haven.analytics.range`, the agent does not.
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    await user.click(screen.getByRole('menuitemradio', { name: 'Research agent' }))
    expect(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)).not.toBe('agent-research')
    expect(JSON.stringify(window.localStorage)).not.toContain('agent-research')
  })
})

describe('Analytics — loading', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({ data: null, loading: true, failed: false, agentNotFound: false, refetch: mockRefetch })
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
    expect(screen.queryByTestId('stat-tile-agents-near-their-budget')).toBeNull()
    expect(screen.queryByTestId('stat-tile-fees-paid-to-haven')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
    expect(screen.queryByText('No agent activity yet')).toBeNull()
  })

  it('keeps the shape of the settled page while it waits, so nothing jumps when it fills', () => {
    render(<AnalyticsClient />)
    const skeleton = screen.getByTestId('analytics-skeleton')
    expect(skeleton.children.length).toBe(2)
    expect(skeleton.children[0].children.length).toBe(4) // the four tiles
    expect(skeleton.children[1].children.length).toBe(4) // header bar plus three rows
    expect(skeleton.querySelectorAll('[class*="rounded-"]').length).toBeGreaterThan(4)
  })
})

describe('Analytics — failure', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({ data: null, loading: false, failed: true, agentNotFound: false, refetch: mockRefetch })
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
    expect(screen.queryByText('No agent activity yet')).toBeNull()
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
    render(<AnalyticsClient />)
    expect(screen.getByRole('alert').textContent).not.toMatch(/500|40[0-9]|TypeError|undefined/)
  })
})

describe('Analytics — the new user (#4333)', () => {
  beforeEach(() => {
    mockUseAgents.mockReturnValue(agentList({ agents: [] }))
    mockUseAnalyticsOverview.mockReturnValue(settled({ data: EMPTY }))
  })

  it('renders one empty state for a user with no agents at all, replacing the zero tiles', () => {
    // "No agents" means no agents at all — revoked included. One state with
    // one sentence replaces the zero tiles and the empty sections: four tiles
    // each asserting "nothing" in the confident layout of a working page is
    // the screen-shape an outage passes for free.
    render(<AnalyticsClient />)
    expect(screen.getByText('No agent activity yet')).toBeTruthy()
    expect(screen.queryByTestId('analytics-tiles')).toBeNull()
    expect(screen.queryByTestId('stat-tile-spent')).toBeNull()
    expect(screen.queryByTestId('analytics-agents-section')).toBeNull()
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers Connect agent, opening the existing connect flow on /agents', () => {
    render(<AnalyticsClient />)
    const link = screen.getByRole('link', { name: 'Connect agent' })
    expect(link.getAttribute('href')).toBe('/agents')
  })

  it('is not the quiet-window state, and not an alert — the endpoint did answer', () => {
    render(<AnalyticsClient />)
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not fire for an agent-owning user, even when the window is quiet', () => {
    // The same empty overview WITH agents on the list is the quiet-window
    // state, not the new-user one: the page can report something, it just
    // has nothing in this range.
    mockUseAgents.mockReturnValue(agentList())
    render(<AnalyticsClient />)
    expect(screen.queryByText('No agent activity yet')).toBeNull()
    expect(screen.getByText('No agent activity in this range')).toBeTruthy()
  })
})

describe('Analytics — the empty window', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: EMPTY,
      loading: false,
      failed: false,
      agentNotFound: false,
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

describe('Analytics — the populated page (#4333 tiles)', () => {
  it('renders the four figures the page answers with, in the order they are scanned', () => {
    render(<AnalyticsClient />)
    const tiles = screen.getByTestId('analytics-tiles')
    const labels = Array.from(tiles.querySelectorAll('[data-testid^="stat-tile-"]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    // The fixture's fee flag is off, so the fees tile is ABSENT — the tile
    // exists only while Haven charges (#4333).
    expect(labels).toEqual([
      'stat-tile-spent',
      'stat-tile-payments',
      'stat-tile-refused',
      'stat-tile-agents-near-their-budget',
    ])
  })

  it('compares Spent against the previous window as an amount, never a pill', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-spent')
    expect(within(tile).getByText('$324.75')).toBeTruthy()
    // The absolute comparison (#4333): the previous window's booked total,
    // beside this one — a ratio of the two is a derivation the endpoint did
    // not make, which is why `percentChange` is gone.
    expect(tile.textContent).toMatch(/vs \$280\.10 the 30 days before/)
    // No delta chip renders anywhere on the tile: the comparison is the
    // footnote, the figure carries no polarity colour.
    expect(tile.textContent).not.toMatch(/[+-]\d+(\.\d+)?%/)
  })

  it('caption the Payments count with the agents it came from', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-payments')
    expect(within(tile).getByText('5')).toBeTruthy()
    // Both fixture agents have payments, so both counts agree; the caption is
    // read off the response's own agents rows, not derived elsewhere.
    expect(tile.textContent).toMatch(/by 2 of 2 agents/)
  })

  it('renders the refusals with the attempts behind them and the caveats in the hint', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-refused')
    expect(within(tile).getByText('2')).toBeTruthy()
    // All agents shown: no Review link — there is no page-level refused list
    // to review (#4333).
    expect(within(tile).queryByText('Review')).toBeNull()
    // The two recording caveats moved ONTO the label as an ⓘ hint: a tooltip
    // elaborates on something already visible, and these two sentences
    // elaborate the count. The floor date is the response's own.
    const trigger = tile.querySelector('span[data-testid="analytics-refused-hint"]')
    expect(trigger).not.toBeNull()
    // The #3055 limit-of-visibility clause: the ONE refusal class the ledger
    // never sees, named by who raises it — and nothing the ledger records.
    expect(tile.textContent).not.toMatch(/Price-cap refusals/)
    expect(tile.textContent).not.toMatch(/quote/i)
    // The price cap and (once the floor exists) its date ride the TOOLTIP
    // content, which renders in a portal on open — asserted in the hint's
    // own test below through the aria-label the trigger carries.
    expect(trigger!.getAttribute('aria-label')).toBeTruthy()
  })

  it('carries the ledger floor and the price-cap note in the refused hint, verbatim', () => {
    // The hint's content is the same sentences the old footnote line printed:
    // the response's floor date (en-GB day + short month) and the price cap.
    // Asserted on the trigger's aria-label, which names the hint for AT —
    // the tooltip's own copy rules (design-system § Tooltips) keep these as
    // elaboration, not essential copy.
    render(<AnalyticsClient />)
    const expected = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
      new Date('2026-05-28'),
    )
    const hint = screen.getByTestId('analytics-refused-hint')
    expect(hint.getAttribute('aria-label')).toContain(`Refusals are recorded from ${expected}`)
    expect(hint.getAttribute('aria-label')).toContain(
      "Price-cap refusals in your agent's runtime are not recorded.",
    )
    expect(hint.getAttribute('aria-label')).not.toMatch(/hosted tools/)
    expect(hint.getAttribute('aria-label')).not.toMatch(/quote/i)
  })

  it('links Review to the agent’s refused attempts only when one agent is filtered (#4333)', async () => {
    // #4323 has landed, so the link is unconditional WHERE a target exists —
    // the agent's activity tab pre-filtered. With all agents shown there is
    // no page-level refused list, so there is nothing to review.
    const { unmount } = render(<AnalyticsClient />)
    expect(screen.queryByTestId('stat-tile-refused')?.textContent).not.toMatch(/Review/)
    unmount()

    mockUseAnalyticsOverview.mockReturnValue(settled({ data: POPULATED }))
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    await user.click(screen.getByRole('menuitemradio', { name: 'Research agent' }))
    const link = screen.getByTestId('stat-tile-refused').querySelector('a')
    expect(link?.getAttribute('href')).toBe('/agents/agent-research?tab=activity&status=refused')
    expect(link?.textContent).toBe('Review')
  })

  it('names the filtered agent on the Payments tile instead of counting agents', async () => {
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    await user.click(screen.getByRole('menuitemradio', { name: 'Research agent' }))
    expect(screen.getByTestId('stat-tile-payments').textContent).toMatch(/Research agent/)
    expect(screen.getByTestId('stat-tile-payments').textContent).not.toMatch(/by \d of \d agents/)
  })

  it('counts the agents near their budget, of the agents with budgets', () => {
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-agents-near-their-budget')
    expect(within(tile).getByText('1/2')).toBeTruthy()
    expect(tile.textContent).toMatch(/above 75% of a period budget/)
  })

  it('renders NO fees tile while the fee flag is off, and one when it is on', () => {
    const { unmount } = render(<AnalyticsClient />)
    // Flag off: no tile at all. A $0.00 there would report "nothing charged
    // this period", which is not the same fact as "the product is not
    // charging fees" — and the absence IS the saying now.
    expect(screen.queryByTestId('stat-tile-fees-paid-to-haven')).toBeNull()
    unmount()

    mockUseAnalyticsOverview.mockReturnValue(settled({ data: FEES_ON }))
    render(<AnalyticsClient />)
    const tile = screen.getByTestId('stat-tile-fees-paid-to-haven')
    expect(within(tile).getByText('$1.25')).toBeTruthy()
    // The gas note rides the tile when the tile exists.
    expect(tile.textContent).toMatch(/Haven sponsored 7 operations' gas/)
  })

  it('mounts the spend chart off the same response, below the agents table and above merchants (#3051; recipe item 5)', () => {
    render(<AnalyticsClient />)
    const spend = screen.getByTestId('analytics-spend-section')
    expect(within(spend).getByRole('heading', { name: 'Spend over time' })).toBeTruthy()
    expect(within(spend).getAllByTestId('stacked-bar-chart')).toHaveLength(2)
    expect(within(spend).getAllByTestId('chart-refusal-marker')).toHaveLength(4)
    const table = screen.getByTestId('analytics-agents-section')
    const merchants = screen.getByTestId('analytics-merchants-section')
    expect(table.compareDocumentPosition(spend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(spend.compareDocumentPosition(merchants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the trend figures and the agents table once there is data', () => {
    render(<AnalyticsClient />)
    // The page-level sparse band is gone (#4333): sections render whenever
    // the window has any activity, each keeping its own guard.
    expect(screen.queryByTestId('analytics-sparse-line')).toBeNull()
    const agentsSection = screen.getByTestId('analytics-agents-section')
    expect(within(agentsSection).getAllByText('Research agent')).toHaveLength(2)
    expect(within(agentsSection).getAllByText('Data-feed agent')).toHaveLength(2)
  })
})

describe('Analytics — the sparse window (#4333: the band is gone)', () => {
  beforeEach(() => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: SPARSE,
      loading: false,
      failed: false,
      agentNotFound: false,
      refetch: mockRefetch,
    })
  })

  it('keeps the tiles and the table — the sparse band no longer hides them together', () => {
    // A total over two days is still the total over those two days, and the
    // agents rows are the same figures. What declines to draw is the CHARTS,
    // each on its own floor — the page no longer removes a whole band of
    // sections behind MIN_CHARTABLE_DAYS (#4333).
    render(<AnalyticsClient />)
    expect(screen.getByTestId('analytics-tiles')).toBeTruthy()
    expect(screen.getByTestId('analytics-agents-section')).toBeTruthy()
    expect(screen.queryByTestId('analytics-sparse-line')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('No agent activity in this range')).toBeNull()
  })

  it('still withholds the merchants table when the response reported no merchant row', () => {
    // Each section keeps its own guard: a sparse window with merchant rows
    // shows them, one without shows none.
    const noMerchants = { ...SPARSE, merchants: [] }
    mockUseAnalyticsOverview.mockReturnValue({
      data: noMerchants,
      loading: false,
      failed: false,
      agentNotFound: false,
      refetch: mockRefetch,
    })
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
  })
})

describe('Analytics — the window the reader chose', () => {
  it('asks for the stored window on the FIRST request, without asking for the default first', () => {
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '90d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenCalledTimes(1)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('90d', 'usd', null)
    expect(screen.getByRole('button', { name: 'Period: Last 90 days' })).toBeTruthy()
  })

  it('asks for the URL period on the FIRST request, ahead of the stored choice', () => {
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '90d')
    window.history.replaceState(null, '', '/analytics?period=7d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('7d', 'usd', null)
    expect(screen.getByRole('button', { name: 'Period: Last 7 days' })).toBeTruthy()
  })

  it('asks for the URL agentId on the FIRST request, without a second fetch (#4333)', () => {
    // An agent page's link to /analytics?agentId=<id> opens already filtered:
    // the initialiser reads the URL, so the first request carries it.
    window.history.replaceState(null, '', '/analytics?agentId=agent-research')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenCalledTimes(1)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', 'agent-research')
  })

  it('falls back to the default when nothing is stored and the URL carries no period', () => {
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', null)
  })

  it('ignores a stored value the endpoint would answer 400 to, and still renders', () => {
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '180d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a URL period the endpoint would answer 400 to, and falls back to the device', () => {
    window.localStorage.setItem(ANALYTICS_RANGE_STORAGE_KEY, '90d')
    window.history.replaceState(null, '', '/analytics?period=180d')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('90d', 'usd', null)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('remembers the window the reader picks, for this device and in the URL', async () => {
    window.history.replaceState(null, '', '/analytics')
    render(<AnalyticsClient />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Period: Last 30 days' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Last 7 days' }))
    expect(window.localStorage.getItem(ANALYTICS_RANGE_STORAGE_KEY)).toBe('7d')
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('7d', 'usd', null)
    // The URL mirrors the choice, so a reload or a shared link reopens it —
    // and it is a replaceState write, so the back button still leaves the page.
    expect(window.location.search).toBe('?period=7d')
    expect(screen.getByRole('button', { name: 'Period: Last 7 days' })).toBeTruthy()
  })

  it('offers exactly the three windows the endpoint documents, and marks the chosen one', async () => {
    render(<AnalyticsClient />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Period: Last 30 days' }))
    const radios = screen.getAllByRole('menuitemradio', { name: /Last (7|30|90) days/ })
    expect(radios.map((r) => r.textContent)).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('offers no All time and no custom range — the endpoint takes a rolling range', async () => {
    render(<AnalyticsClient />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Period: Last 30 days' }))
    const labels = screen.getAllByRole('menuitemradio').map((r) => r.textContent)
    expect(labels).not.toContain('All time')
    expect(labels).not.toContain('Custom range')
  })

  it('clears the agent filter from the URL when All agents is picked again', async () => {
    window.history.replaceState(null, '', '/analytics?agentId=agent-research')
    render(<AnalyticsClient />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Agent: Research agent' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'All agents' }))
    expect(window.location.search).not.toContain('agentId')
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', null)
  })
})

describe('Analytics — the currency is the one the Settings surface owns', () => {
  it('sends the preference on the wire and renders the same one in the tiles', () => {
    preferences('EUR')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'eur', null)
    const tile = screen.getByTestId('stat-tile-spent')
    expect(tile.textContent).toMatch(/324,75/)
    expect(tile.textContent).not.toContain('$')
  })

  it('renders USD when the preference is USD, so the two currencies are both covered', () => {
    preferences('USD')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'usd', null)
    expect(screen.getByTestId('stat-tile-spent').textContent).toMatch(/\$324\.75/)
  })

  it('sends sek on the wire for a SEK preference and renders sv-SE figures in the tiles (#3127)', () => {
    preferences('SEK')
    render(<AnalyticsClient />)
    expect(mockUseAnalyticsOverview).toHaveBeenLastCalledWith('30d', 'sek', null)
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
 * columns, the kind lines and the link target; the chart's own primitives are
 * pinned at their homes in the design system). The fixtures are the capture
 * harness's again, imported and not re-typed.
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
  return { data, loading: false, failed: false, agentNotFound: false, refetch: mockRefetch }
}

describe('Analytics — the merchants and balance sections (slice E, #2949)', () => {
  it('mounts both sections off the one response the page already has', () => {
    render(<AnalyticsClient />)
    expect(screen.getByTestId('analytics-merchants-section')).toBeTruthy()
    expect(screen.getByTestId('analytics-balance-section')).toBeTruthy()
    expect(mockUseAnalyticsOverview).toHaveBeenCalledTimes(1)
  })

  it('lists the three harness merchants under a heading, in the endpoint’s order', () => {
    render(<AnalyticsClient />)
    const page = screen.getByTestId('analytics-page')
    const heading = within(page).getByRole('heading', { level: 2, name: 'Top merchants' })
    expect(heading).toBeTruthy()
    const rows = Array.from(
      screen.getByTestId('analytics-merchants-section').querySelectorAll('tbody tr'),
    )
    // #4333: an unresolved label reads "Unknown recipient" — no cell renders
    // a 0x… address as a label.
    expect(rows.map((row) => row.querySelectorAll('td')[0].querySelector('span.font-medium')?.textContent)).toEqual([
      FIXTURE_ANALYTICS_MERCHANTS[0].label,
      FIXTURE_ANALYTICS_MERCHANTS[1].label,
      'Unknown recipient',
    ])
  })

  it('renders the chart’s accessible name from the wire rows, not from a typed sentence', () => {
    render(<AnalyticsClient />)
    const svg = screen.getByTestId('analytics-balance-section').querySelector('svg[role="img"]')
    const label = svg?.getAttribute('aria-label') ?? ''
    expect(label).toMatch(/^Balance over 30 days:/)
    expect(label).toContain(`started at ${formatAnalyticsValue(Number(FIRST_SNAPSHOT.value), 'USD')}`)
    expect(label).toContain(`ended at ${formatAnalyticsValue(Number(LAST_SNAPSHOT.value), 'USD')}`)
    // #4333: the movement is a SIGNED net change, not a "gained"/"spent" verb.
    expect(label).toContain('Net change')
    expect(label).not.toMatch(/\b(gained|spent)\b/)
  })

  it('follows the wire: change the last snapshot and the summary sentence changes', () => {
    mockUseAnalyticsOverview.mockReturnValue(settledWith(LONGER_LAST))
    render(<AnalyticsClient />)
    const svg = screen.getByTestId('analytics-balance-section').querySelector('svg[role="img"]')
    // Signed fall: the moved last snapshot (9,999.00) sits below the fixture's
    // actual first one, so the net change reads with a minus, computed from
    // the same rows the sentence is.
    expect(svg?.getAttribute('aria-label')).toContain(
      `Net change -${formatAnalyticsValue(Math.abs(9_999 - Number(FIRST_SNAPSHOT.value)), 'USD')}`,
    )
  })

  it('says the chart is not filtered when the Agent facet is set (#4333)', async () => {
    // The balance series is per-user; an agent-filtered page must say so or
    // the reader reads the OTHER agents' movements as this agent's.
    const user = userEvent.setup()
    render(<AnalyticsClient />)
    await user.click(agentFacetTrigger())
    await user.click(screen.getByRole('menuitemradio', { name: 'Research agent' }))
    expect(screen.getByTestId('analytics-balance-section').textContent).toMatch(
      /Balance isn’t filtered by agent/,
    )
  })

  it('speaks the chart in the currency the Settings surface owns, as it speaks the tiles', () => {
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
    // chart system's own constant — the section's OWN guard now that the
    // page-level sparse band is gone (#4333). The merchants table stands.
    mockUseAnalyticsOverview.mockReturnValue(settledWith(SHORT_BALANCE))
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
    expect(screen.getByTestId('analytics-merchants-section')).toBeTruthy()
  })

  it('renders neither section in the empty window, where the page answers with its own state', () => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: EMPTY,
      loading: false,
      failed: false,
      agentNotFound: false,
      refetch: mockRefetch,
    })
    const { container } = render(<AnalyticsClient />)
    expect(container.textContent).toMatch(/No agent activity in this range/)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
  })

  it('renders neither section on a failed request, which is an error and not an absence', () => {
    mockUseAnalyticsOverview.mockReturnValue({
      data: null,
      loading: false,
      failed: true,
      agentNotFound: false,
      refetch: mockRefetch,
    })
    render(<AnalyticsClient />)
    expect(screen.queryByTestId('analytics-merchants-section')).toBeNull()
    expect(screen.queryByTestId('analytics-balance-section')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('reports money and never savings, in the two sections as in the tiles', () => {
    render(<AnalyticsClient />)
    const page = screen.getByTestId('analytics-page').textContent ?? ''
    expect(page).not.toMatch(/\bsavings\b/i)
    expect(page).not.toMatch(/\bwallet\b/i)
  })
})
