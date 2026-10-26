import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AgentsTable } from '../AgentsTable'
import { orderAgentsForDisplay } from '@/lib/analytics-series'
import type { AnalyticsAgentRow } from '@/types/analytics'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'

/**
 * The agents table's two-renderings rule (#2947, slice C; #4333 columns).
 *
 * Below `lg` there is no width for the columns, and the collapse primitive
 * inside `Table` would keep two or three of them and drop the rest — silently
 * deleting exactly the figures the row exists to show. So the desktop table
 * and the mobile row list are the SAME data in two layouts, and the pair is
 * complements by construction: one container carries `hidden lg:block`, the
 * other `lg:hidden`, so exactly one is displayed at any width.
 *
 * #4333 reshapes the columns: the Share column merges into Spent ("N% of
 * spend" under the figure), Refused becomes the link to that agent's refused
 * attempts (#4323), the Agent cell carries the monogram, the WHOLE row links
 * to the agent, and an unresolved top merchant reads "Unknown recipient" —
 * never a `0x…` address as a label.
 *
 * Fixtures are the capture harness's own rows, imported the way
 * `screenshot-fixture.test.ts` imports them, so the unit assertions and the
 * rendered evidence describe the same endpoint.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))

const [RESEARCH, RETIRED] = FIXTURE_ANALYTICS_OVERVIEW.agents as unknown as AnalyticsAgentRow[]

function mount() {
  const view = render(<AgentsTable agents={[RESEARCH, RETIRED]} currency="USD" />)
  return { ...view, container: view.container as HTMLElement }
}

/** The desktop half, found by the breakpoint pair that makes it the desktop half. */
function desktopOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[class*="hidden"][class*="lg:block"]')
}

/** The mobile half, the complement of the same pair. */
function mobileOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[class*="lg:hidden"]')
}

describe('AgentsTable — the desktop table (#4333 columns)', () => {
  it('names every column the rebuild defines, in the order the reader scans them', () => {
    const { container } = mount()
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
    expect(heads).toEqual([
      'Agent',
      'Spent',
      'Payments',
      'Refused',
      'Budget',
      'Top merchant',
      'Last paid',
    ])
  })

  it('renders one row per agent the endpoint lists, in the order it sent them', () => {
    // The endpoint ranks by spend; the table inherits that ranking. Choosing a
    // second order here would be a second answer to "which agent spent most".
    // The Agent cell opens with the monogram's initials, so the NAME span is
    // what the order is asserted on.
    const { container } = mount()
    const firstCells = Array.from(container.querySelectorAll('tbody tr > td:first-child')).map(
      (td) => td.querySelector('span.truncate')?.textContent,
    )
    expect(firstCells).toEqual(['Research agent', 'Data-feed agent'])
  })

  it('renders the booked figures through the shared formatters, not as raw fields', () => {
    const { container } = mount()
    const row = container.querySelectorAll('tbody tr')[0]
    const text = row.textContent ?? ''
    expect(text).toContain('$312.25') // spent, via the money formatter
    // The former Share column, merged in (#4333): the slice of the window's
    // spend under its own figure.
    expect(text).toContain('96% of spend')
    const cells = row.querySelectorAll('td')
    expect(cells[2].textContent).toBe('4') // payments, as the integer it is
    expect(text).toContain('1 · 2 attempts') // refusals plus the attempts behind them
    expect(text).toContain('NordShield VPN') // a label the API resolved, not this table
  })

  it('carries the agent monogram beside the name, and the revoked badge instead of a truncation', () => {
    const revokedRow = { ...RETIRED, status: 'revoked' as const }
    const view = render(<AgentsTable agents={[revokedRow]} currency="USD" />)
    const container = view.container as HTMLElement
    // The monogram is the same tinted mark the spend chart keys the agent by
    // (#4331) — one colour per agent, in the table too.
    expect(container.querySelector('[data-testid="analytics-agents-section"]')).toBeNull()
    const nameCell = container.querySelectorAll('tbody tr td')[0]
    expect(nameCell.querySelector('img, [class*="rounded-full"]')).not.toBeNull()
    expect(container.textContent).toContain('Data-feed agent')
    const badge = Array.from(container.querySelectorAll('[class*="rounded-full"]')).find(
      (el) => el.textContent === 'Revoked',
    )
    expect(badge).toBeDefined()
    expect(badge!.className).toContain('text-[var(--v2-danger)]')
  })

  it('never renders a 0x… address AS the label: an unresolved merchant reads Unknown recipient', () => {
    // #4332 made `top_merchant.label` nullable; #4333 replaces the shim that
    // rendered the address with "Unknown recipient". The address survives as
    // the tooltip — elaboration on a name, the one thing a tooltip is for —
    // and the full string is reachable, but the NAME cell is never a hex
    // string.
    const { container } = mount()
    const retired = container.querySelectorAll('tbody tr')[1]
    const cell = retired.querySelectorAll('td')[5]
    expect(cell.textContent).toBe('Unknown recipient')
    const trigger = cell.querySelector('span[aria-describedby]') ?? cell.querySelector('span')
    expect(trigger?.textContent).toBe('Unknown recipient')
    expect(cell.textContent).not.toMatch(/0x/)
    // The monogram keys on the name either way, so an unknown keeps a tint.
  })

  it('refused is a link to that agent\u2019s refused attempts (#4323/#4333)', () => {
    const { container } = mount()
    const refused = container.querySelectorAll('tbody tr')[0].querySelectorAll('td')[3]
    const link = refused.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/agents/agent-research?tab=activity&status=refused')
    expect(link?.textContent).toContain('1')
    expect(link?.textContent).toContain('2 attempts')
  })

  it('keeps "1 · 2 attempts" on one line, built by the one formatter the phone row uses too (#4426)', async () => {
    // The desktop link wrapped at 1280 ("1 · 2" over "attempts"), and the
    // string was built twice — once here, once in the phone disclosure. Both
    // now read `formatRefusedCount`, so the two renderings print the same
    // bytes. Mutations: drop `whitespace-nowrap` from the link → red; build
    // either half inline with a different separator → red.
    const { container } = mount()
    const link = container.querySelectorAll('tbody tr')[0].querySelectorAll('td')[3].querySelector('a')!
    expect(link.textContent).toBe('1 · 2 attempts')
    expect(link.className.split(/\s+/)).toContain('whitespace-nowrap')
    const firstRow = mobileOf(container)!.querySelector('div') as HTMLElement
    await userEvent.click(within(firstRow).getByRole('button', { name: 'More' }))
    const term = within(firstRow).getByText('Refused')
    expect(term.nextElementSibling?.textContent).toBe('1 · 2 attempts')
  })

  it('does not pad the refusals cell with an attempts clause when the two agree', () => {
    // A dedupe upstream makes rows and attempts usually equal, and spelling
    // the pair every time would train the reader to stop parsing the cell.
    const { container } = mount()
    const retired = container.querySelectorAll('tbody tr')[1]
    expect(retired.querySelectorAll('td')[3].textContent).toBe('1') // refusals: one row, no attempts clause
    expect(retired.textContent ?? '').not.toMatch(/1 · 1 attempts/)
  })

  it('renders a stale or failed read as unknown — no bar, never a snapshot claim (#3806)', () => {
    // Frozen at the capture instant the e2e fixture was built for: the
    // response's period bounds end the day BEFORE the clock, so even the
    // successful read describes a finished period (refilled-updating) and the
    // failed read was never a measurement (unknown). Neither row renders a
    // bar — a 0 % bar would claim "nothing used".
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-12T09:00:00Z'))
    try {
      const { container } = mount()
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
      const rows = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent ?? '')
      expect(rows[0]).toMatch(/couldn.t be read/)
      expect(rows[1]).toMatch(/couldn.t be read/)
      for (const text of rows) expect(text).not.toMatch(/last snapshot/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('states the budget figures once, through the shared row caption — never 0.00 of 0.00 (#4333, #4426)', () => {
    // The #4333 root cause: the caption helper divided a symbol-only row
    // (chainId null — the analytics read carries the SYMBOL, not the chain)
    // by 18 decimals, so a 1.00 USDC budget read "0.00 of 0.00". #4426: the
    // cell printed its own figure line ("0.00 of 1.00 USDC", 0%) above the
    // meter and then the caption said the same figures again. Now the cell
    // asks for the compact `style: 'row'` caption the dashboard agent row and
    // the agent hero use, and prints no figure line. Asserted as the EXACT
    // caption — the period word in place of "used this period", the no-break
    // space between the cap and its symbol — and as one occurrence, so a
    // returning figure line or a `'full'` caption cannot hide behind a
    // partial match.
    const agent: AnalyticsAgentRow = {
      ...RESEARCH,
      budgets: [
        {
          token: 'USDC',
          recipient: null,
          used_atomic: '0',
          budget_atomic: '1000000',
          remaining_from_chain: true,
          period_start: '2026-07-10T00:00:00.000Z',
          period_end: '2026-07-13T00:00:00.000Z',
          // No `chain_id` on the wire row — the analytics read carries the
          // token's SYMBOL only, which is exactly the shape the caption fix
          // addresses. (The generated type makes it optional-undefined; the
          // component itself projects `chainId: null` onto the caption.)
        },
      ],
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-12T09:00:00Z'))
    try {
      const { container } = render(<AgentsTable agents={[agent]} currency="USD" />)
      const cell = (container.querySelector('tbody tr') as HTMLElement).querySelectorAll('td')[4]
      const text = cell.textContent ?? ''
      expect(text).toBe('0.00 of 1.00\u00a0USDC · every 3 days · refills in 15h')
      expect(text.match(/of 1\.00/g)).toHaveLength(1)
      expect(text).not.toContain('used this period')
      expect(text).not.toContain('0.00 of 0.00')
      expect(text).not.toMatch(/\d%/)
      expect(cell.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says a budget that has not started yet in the helper\u2019s words, rather than an empty cell (#4426)', () => {
    // With no figure line above the meter, a caption kind that draws no bar
    // must still say something: the helper's own words, not a blank cell.
    // The analytics read carries no `expires_at`, so the reachable kinds
    // without a bar are unknown, refilled-updating (both UNREAD_CAPTION,
    // pinned above) and not-started — a period that begins after the clock.
    // Mutation: render the unread kinds only → the cell is empty → red.
    const agent: AnalyticsAgentRow = {
      ...RESEARCH,
      budgets: [
        {
          token: 'USDC',
          recipient: null,
          used_atomic: '0',
          budget_atomic: '1000000',
          remaining_from_chain: true,
          period_start: '2026-07-10T00:00:00.000Z',
          period_end: '2026-07-13T00:00:00.000Z',
        },
      ],
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-09T09:00:00Z'))
    try {
      const { container } = render(<AgentsTable agents={[agent]} currency="USD" />)
      const cell = (container.querySelector('tbody tr') as HTMLElement).querySelectorAll('td')[4]
      expect(cell.textContent).toMatch(/^Starts /)
      expect(cell.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says "no budget set" in words rather than rendering an empty bar', () => {
    // A bar at zero and a bar for a delegation that does not exist are two
    // different facts, and a flat bar reports the first of them.
    const bare = { ...RETIRED, budgets: [] }
    const view = render(<AgentsTable agents={[bare]} currency="USD" />)
    const container = view.container as HTMLElement
    expect(container.textContent).toContain('No budget')
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(0)
  })

  it('answers both null cases in words rather than with an empty cell', () => {
    // A bare "-" in the merchant column is read as "nothing here" and as
    // "unknown" with equal ease by two readers, and the table cannot tell them
    // which it meant. The endpoint reports absence; the cell states it.
    const bare = { ...RETIRED, top_merchant: null, last_payment_at: null }
    const view = render(<AgentsTable agents={[bare]} currency="USD" />)
    const text = (view.container as HTMLElement).textContent ?? ''
    expect(text).toContain('None in this range')
    expect(text).toContain('No payments in this range')
  })

  it('links the whole row to the agent, with the Agent cell\u2019s link as the keyboard half', () => {
    const { container } = mount()
    const row = container.querySelectorAll('tbody tr')[0] as HTMLElement
    // The pointer half: the row itself navigates (client-side), so any cell
    // click is a way in.
    expect(row.className).toContain('cursor-pointer')
    expect(row.getAttribute('onclick') ?? '').toBe('')
    // The keyboard half: the Agent cell's Link carries the destination for
    // focus and AT.
    const cellLink = row.querySelector('td:first-child a')
    expect(cellLink?.getAttribute('href')).toBe('/agents/agent-research')
  })

  it('stages the widest column behind the shell\u2019s own breakpoint', () => {
    // Top merchant is the `revealAt="xl"` column. Its cell carries the
    // primitive's own stage token rather than a hand-written breakpoint,
    // which is what keeps this table's narrow behaviour the same as every
    // other table in the app — and what `table-container-collapse.spec.ts`
    // anchors on.
    const { container } = mount()
    const staged = Array.from(container.querySelectorAll('thead th')).filter((th) =>
      th.className.includes('min-width:974px'),
    )
    expect(staged.map((th) => th.textContent)).toEqual(['Top merchant'])
  })
})

describe('AgentsTable — one colour per agent (#4331)', () => {
  it('carries no series swatch in either rendering: the monogram is the colour key', () => {
    // Since #4331 the agent's colour lives on its monogram (the same avatar
    // tint `seriesColorForAgent` feeds the spend chart) — a second coloured
    // dot in the spend cell would read as a status light and duplicate it.
    const agents = orderAgentsForDisplay([RESEARCH, RETIRED])
    const { container } = render(<AgentsTable agents={agents} currency="USD" />)
    const desktop = desktopOf(container)!
    const mobile = mobileOf(container)!
    expect(desktop.querySelectorAll('[data-testid="series-swatch"]')).toHaveLength(0)
    expect(mobile.querySelectorAll('[data-testid="series-swatch"]')).toHaveLength(0)
    expect(desktop.querySelectorAll('[data-testid="series-swatch-slot"]')).toHaveLength(0)
    expect(container.textContent).toContain('$')
  })
})

describe('AgentsTable — the mobile rows', () => {
  it('carries the complementary breakpoint classes that make the pair one table', () => {
    // The structural half of the two-renderings rule, and the only half jsdom
    // can see (it applies no stylesheet, so CSS visibility is invisible to a
    // DOM query). One container is `hidden lg:block`, the other `lg:hidden`:
    // the same prefix, one with `hidden`, so exactly one displays at any
    // width. An author who changed one without the other would get two tables
    // at desktop or none on a phone.
    const { container } = mount()
    const desktop = desktopOf(container)
    const mobile = mobileOf(container)
    expect(desktop).not.toBeNull()
    expect(mobile).not.toBeNull()
    expect(desktop!.querySelector('table')).not.toBeNull()
    expect(mobile!.querySelector('table')).toBeNull()
    expect(mobile!.querySelectorAll(':scope > div').length).toBe(2) // one per agent
  })

  it('keeps spend, refusals and the budget on the face of the row', () => {
    // The three a reader at a bus stop is most likely asking about. They are
    // NOT behind the disclosure, and they are the same fields the desktop
    // table renders, so the two layouts cannot disagree about a figure.
    const text = mobileOf(mount().container)?.textContent ?? ''
    expect(text).toContain('Research agent')
    expect(text).toContain('$312.25 spent') // compacted for the narrow column
    expect(text).toContain('1 refused')
    expect(text).toContain('214.00 of 250.00 USDC')
    expect(text).toContain('86%')
  })

  it('puts the rest of the columns in a disclosure that opens, and is not a second source', async () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement

    expect(within(firstRow).queryByText('Top merchant')).toBeNull()
    const toggle = within(firstRow).getByRole('button', { name: 'More' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    for (const term of ['Payments', 'Refused', 'Share of spend', 'Spend', 'Top merchant', 'Last payment']) {
      expect(within(firstRow).getByText(term)).toBeTruthy()
    }
    expect(within(firstRow).getByText('NordShield VPN')).toBeTruthy()
  })

  it('names the agent once on the face of the row, not once per open section', () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    expect(within(firstRow).getAllByText('Research agent').length).toBe(1)
  })

  it('links the row to the agent and the refusals to the refused attempts', () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    const hrefs = Array.from(firstRow.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/agents/agent-research')
    expect(hrefs).toContain('/agents/agent-research?tab=activity&status=refused')
  })
})

describe('AgentsTable — the card it lives in', () => {
  it('is titled by what it lists, and the title is a heading', () => {
    // The heading level matters for the page's outline: the table is a
    // section of the Analytics page and announces itself as one.
    const { container } = mount()
    expect(container.querySelector('h2')?.textContent).toBe('Agents')
  })

  it('renders no rows for an empty list rather than a frame that pretends', () => {
    // The page does not reach this with an empty list — the whole-window empty
    // state answers that case upstream — so an empty frame here would be the
    // component disagreeing with the page about whether there is anything to
    // report.
    const view = render(<AgentsTable agents={[]} currency="USD" />)
    const container = view.container as HTMLElement
    expect(container.querySelectorAll('tbody tr').length).toBe(0)
    expect(container.textContent).not.toMatch(/No agent activity/)
  })
})
