import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AgentsTable } from '../AgentsTable'
import { seriesColor } from '@/components/ui/StackedBarChart'
import type { AnalyticsAgentRow } from '@/types/analytics'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'

/**
 * The agents table's two-renderings rule (#2947, slice C).
 *
 * Below `lg` there is no width for seven columns, and the collapse primitive
 * inside `Table` would keep two or three of them and drop the rest — silently
 * deleting exactly the figures the row exists to show. So the desktop table
 * and the mobile row list are the SAME data in two layouts, and the pair is
 * complements by construction: one container carries `hidden lg:block`, the
 * other `lg:hidden`, so exactly one is displayed at any width.
 *
 * The mobile rendering is the one that needs the hard assertion. jsdom applies
 * no stylesheet, so CSS visibility is invisible to a DOM query, and the honest
 * thing this file can pin is therefore STRUCTURE rather than appearance: that
 * the desktop half carries every column for every row, that the mobile half
 * keeps spend, refusals and budget on the face of the row and carries the rest
 * in a disclosure that OPENS, and that the two containers carry the
 * complementary breakpoint classes that make them one table and not two.
 *
 * Cell text is matched with `toMatch` against the row rather than by exact
 * equality per cell, because a composite cell (the budget cell is a value, a
 * percentage, a bar, and a reset date) has one text node run, not three.
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

describe('AgentsTable — the desktop table', () => {
  it('names every column the aggregate reports, in the order the reader scans them', () => {
    const { container } = mount()
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
    expect(heads).toEqual([
      'Agent',
      'Spend',
      'Share',
      'Payments',
      'Refusals',
      'Budget used',
      'Top merchant',
      'Last payment',
    ])
  })

  it('renders one row per agent that spent, in the order the endpoint sent them', () => {
    // The endpoint ranks by spend; the table inherits that ranking. Choosing a
    // second order here would be a second answer to "which agent spent most".
    const { container } = mount()
    const firstCells = Array.from(container.querySelectorAll('tbody tr > td:first-child')).map(
      (td) => td.textContent,
    )
    expect(firstCells).toEqual(['Research agent', 'Data-feed agent'])
  })

  it('renders the booked figures through the shared formatters, not as raw fields', () => {
    const { container } = mount()
    const row = container.querySelectorAll('tbody tr')[0]
    const text = row.textContent ?? ''
    expect(text).toMatch(/\$312\.25/) // spent, via the money formatter
    expect(text).toMatch(/96%/) // share, rounded
    const cells = row.querySelectorAll('td')
    expect(cells[3].textContent).toBe('4') // payments, as the integer it is
    expect(text).toMatch(/1 · 2 attempts/) // refusals plus the attempts behind them
    expect(text).toMatch(/214\.00 of 250\.00 USDC/) // the delegation's own units
    expect(text).toMatch(/NordShield VPN/) // a label the API resolved, not this table
  })

  it('truncates a merchant whose label never resolved to a name, and keeps the whole thing readable', () => {
    // The endpoint returns the address itself when there is no contact and no
    // receipt name behind it. At table width an un-truncated `0x…` clipped
    // mid-glyph: no ellipsis, no way to read the whole thing. So it goes through
    // `lib/format.truncate` — the app's one address rule (#853) — and the full
    // string rides in the title so the reader can still get it. NordShield VPN
    // is pinned un-truncated by the formatter test above, which is what keeps
    // this from passing if the address branch inverts.
    const { container } = mount()
    const retired = container.querySelectorAll('tbody tr')[1]
    const cell = retired.querySelectorAll('td')[6]
    expect(cell.textContent).toBe('0x71C2…7128')
    expect(cell.querySelector('span[title]')?.getAttribute('title')).toBe(
      '0x71C2E8a4D5f6093b1a7C8e2F4B6D0A9C3E5F7128',
    )
  })

  it('does not pad the refusals cell with an attempts clause when the two agree', () => {
    // A dedupe upstream makes rows and attempts usually equal, and spelling
    // the pair every time would train the reader to stop parsing the cell.
    const { container } = mount()
    const retired = container.querySelectorAll('tbody tr')[1]
    expect(retired.querySelectorAll('td')[4].textContent).toBe('1') // refusals: one row, no attempts clause
    expect(retired.textContent ?? '').not.toMatch(/1 · 1 attempts/)
  })

  it('keeps a closed-out agent in the table and marks it, rather than hiding the spending', () => {
    // An agent that has been revoked still spent what it spent in this range,
    // and dropping the row would drop the history along with the account. The
    // badge says the status; the row stays because the money happened.
    const revokedRow = { ...RETIRED, status: 'revoked' }
    const view = render(<AgentsTable agents={[revokedRow]} currency="USD" />)
    const container = view.container as HTMLElement
    expect(container.textContent).toContain('Data-feed agent')
    const badge = Array.from(container.querySelectorAll('[class*="rounded-full"]')).find(
      (el) => el.textContent === 'Revoked',
    )
    expect(badge).toBeDefined()
    expect(badge!.className).toContain('text-[var(--v2-danger)]')
  })

  it('marks the budget bar as a measurement, and says when the measurement is a snapshot', () => {
    const { container } = mount()
    const bars = Array.from(container.querySelectorAll('[role="progressbar"]'))
    expect(bars.length).toBe(2)
    expect(bars[0].getAttribute('aria-valuenow')).toBe('86')
    expect(bars[0].getAttribute('aria-valuemin')).toBe('0')
    expect(bars[0].getAttribute('aria-valuemax')).toBe('100')
    expect(bars[0].getAttribute('aria-label')).toBe('USDC budget used')

    // The two readings are not the same claim. "214 of 250" read from the
    // chain is the delegation as it stands; the same words read from Haven's
    // last snapshot are a record of it. The response says which one it is, so
    // the cell says it too rather than letting the reader assume the stronger.
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent ?? '')
    expect(rows[0]).not.toMatch(/last snapshot/)
    expect(rows[1]).toMatch(/read from Haven’s last snapshot/)
  })

  it('says "no budget set" in words rather than rendering an empty bar', () => {
    // A bar at zero and a bar for a delegation that does not exist are two
    // different facts, and a flat bar reports the first of them.
    const bare = { ...RETIRED, budgets: [] }
    const view = render(<AgentsTable agents={[bare]} currency="USD" />)
    const container = view.container as HTMLElement
    expect(container.textContent).toContain('No budget set')
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

  it('links each row to the agent, so a column of names is a column of ways in', () => {
    const { container } = mount()
    const links = Array.from(container.querySelectorAll('tbody a')).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/agents/agent-research', '/agents/agent-retired'])
  })

  it('stages the two widest columns behind the shell’s own breakpoint', () => {
    // Share and top merchant are the `revealAt="xl"` pair. Their cells carry
    // the primitive's own stage token rather than a hand-written breakpoint,
    // which is what keeps this table's narrow behaviour the same as every other
    // table in the app instead of a second invention of it.
    const { container } = mount()
    const staged = Array.from(container.querySelectorAll('thead th')).filter((th) =>
      th.className.includes('min-width:974px'),
    )
    expect(staged.map((th) => th.textContent)).toEqual(['Share', 'Top merchant'])
  })
})

describe('AgentsTable — one colour per agent, shared with the spend chart (#3051)', () => {
  it('puts the series swatch for row i beside the name, in both renderings, keyed on the endpoint order', () => {
    const { container } = mount()
    const desktop = desktopOf(container)!
    const mobile = mobileOf(container)!
    const desktopSwatches = desktop.querySelectorAll('[data-testid="series-swatch"]')
    const mobileSwatches = mobile.querySelectorAll('[data-testid="series-swatch"]')
    expect(desktopSwatches).toHaveLength(2)
    expect(mobileSwatches).toHaveLength(2)
    expect(Array.from(desktopSwatches).map((el) => el.getAttribute('data-series-index'))).toEqual(['0', '1'])
    expect(Array.from(mobileSwatches).map((el) => el.getAttribute('data-series-index'))).toEqual(['0', '1'])
    // The colour is the chart's own token by index — the same
    // `seriesColor(0)` the first stacked segment is filled with.
    expect((desktopSwatches[0] as HTMLElement).style.backgroundColor).toBe(seriesColor(0))
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
    // Every line the disclosure reveals is a field the desktop table already
    // renders; the disclosure is where the columns a phone had no room for
    // went, not a second place a value can be wrong.
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement

    // Closed by default: a row that is always open is a row that is always
    // too tall for a phone.
    expect(within(firstRow).queryByText('Top merchant')).toBeNull()
    const toggle = within(firstRow).getByRole('button', { name: 'More' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    for (const term of ['Payments', 'Refusals', 'Share', 'Spend', 'Top merchant', 'Last payment']) {
      expect(within(firstRow).getByText(term)).toBeTruthy()
    }
    expect(within(firstRow).getByText('NordShield VPN')).toBeTruthy()
  })

  it('names the agent once on the face of the row, not once per open section', () => {
    // The title is the row's identity; a second copy inside the disclosure
    // would be a second thing to keep in step with the first.
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    expect(within(firstRow).getAllByText('Research agent').length).toBe(1)
  })

  it('links each row to the agent there too, because a row without a way in is a dead end', () => {
    const mobile = mobileOf(mount().container)!
    const links = Array.from(mobile.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/agents/agent-research', '/agents/agent-retired'])
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
