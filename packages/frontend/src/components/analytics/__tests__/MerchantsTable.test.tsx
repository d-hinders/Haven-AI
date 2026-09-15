import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MerchantsTable, MERCHANTS_LINK_TARGET } from '../MerchantsTable'
import type { AnalyticsAgentRow, AnalyticsMerchantRow } from '@/types/analytics'
import { formatAnalyticsAmount, formatAnalyticsDay } from '@/lib/analytics-format'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'

/**
 * The top merchants table (#2949, epic #2944 slice E).
 *
 * Four rules the component is built on and every one of them is pinned here,
 * because each is a place a future edit could quietly break the page's
 * honesty rather than break its layout:
 *
 *   1. the ranking is the endpoint's, inherited not chosen;
 *   2. the label is the API's resolution (contact → receipt name → address)
 *      and the table never re-resolves it — it only decides how a label that
 *      is still an address is DISPLAYED, through the one shared rule;
 *   3. the figures are the wire's, formatted at the edge and never recomputed;
 *   4. the link goes where it can be honored — see `THE LINK TARGET` below.
 *
 * Fixtures are the CAPTURE HARNESS's own rows, imported exactly as
 * `AgentsTable.test.tsx` and `screenshot-fixture.test.ts` import them, so the
 * unit assertions and the rendered PNGs describe one endpoint and not two.
 * The fixture deliberately carries all three label resolutions the API can
 * produce, which is what lets one render pin all three branches of rule 2
 * against real bytes rather than against hand-typed stand-ins.
 *
 * jsdom applies no stylesheet, so the two-renderings rule is pinned
 * STRUCTURALLY — the complementary breakpoint classes on the pair of
 * containers — exactly as the agents table's suite does it. What is visible
 * at 1280 and at 390 is the capture's business.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

const MERCHANTS = FIXTURE_ANALYTICS_OVERVIEW.merchants as unknown as AnalyticsMerchantRow[]
const AGENTS = FIXTURE_ANALYTICS_OVERVIEW.agents as unknown as AnalyticsAgentRow[]

/** The three rows the harness declares: receipt name, contact name, address-only. */
const [RECEIPT_ROW, CONTACT_ROW, ADDRESS_ROW] = MERCHANTS

function mount(merchants: AnalyticsMerchantRow[] = MERCHANTS, agents: AnalyticsAgentRow[] = AGENTS) {
  const view = render(<MerchantsTable merchants={merchants} agents={agents} currency="USD" />)
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

function desktopRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('tbody tr'))
}

describe('MerchantsTable — the desktop table', () => {
  it('names every column the aggregate reports, in the order the reader scans them', () => {
    const { container } = mount()
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
    expect(heads).toEqual([
      'Merchant',
      'Address',
      'Spent',
      'Payments',
      'Paying agents',
      'First seen',
      'Last seen',
    ])
  })

  it('renders one row per merchant, in the order the endpoint sent them', () => {
    // The endpoint ranks by spend and sends the top ten; choosing a second
    // order here would be a second answer to "which merchant got the most".
    const { container } = mount()
    const firstCells = desktopRows(container).map((tr) => tr.querySelectorAll('td')[0].textContent)
    expect(firstCells).toEqual(['NordShield VPN', 'Klara Data AB', '0x71C2…7128'])
  })

  it('renders the booked figures through the shared formatters, not as raw fields', () => {
    // A row that printed `225.00` would be a number the wire sent and a
    // string the reader misreads; the currency voice is the one the tiles use.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe(formatAnalyticsAmount('225.00', 'USD'))
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe(formatAnalyticsAmount('87.25', 'USD'))
    expect(rows[2].querySelectorAll('td')[2].textContent).toBe(formatAnalyticsAmount('12.50', 'USD'))
    // Payments is one of B's number-typed counts: printed as the integer it
    // is, with no currency and no grouping attached to it.
    expect(rows[0].querySelectorAll('td')[3].textContent).toBe('3')
    expect(rows[1].querySelectorAll('td')[3].textContent).toBe('1')
  })

  it('trusts the API’s label resolution and never re-resolves it', () => {
    // The fixture carries one row per resolution the endpoint can produce.
    // A contact name and a receipt name are not addresses: they keep their
    // own characters, their own spacing, and get no title.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[0].textContent).toBe('NordShield VPN')
    expect(rows[1].querySelectorAll('td')[0].textContent).toBe('Klara Data AB')
    expect(rows[0].querySelector('td a span[title]')).toBeNull()
    expect(rows[1].querySelector('td a span[title]')).toBeNull()
  })

  it('truncates a label that never resolved past the address, and keeps the whole thing readable', () => {
    // The third resolution: no contact, no receipt name, so the label IS the
    // address. At table width an un-truncated `0x…` clips mid-glyph with no
    // ellipsis and no way to read the whole thing, so it goes through the one
    // app rule (#853) and the full string rides in the title.
    const rows = desktopRows(mount().container)
    const label = rows[2].querySelectorAll('td')[0]
    expect(label.textContent).toBe('0x71C2…7128')
    expect(label.querySelector('span[title]')?.getAttribute('title')).toBe(ADDRESS_ROW.address)
    // Tabular figures only on the address branch: two rows' addresses must
    // not jitter against each other, while a name keeps normal spacing.
    expect(label.querySelector('span')?.className).toContain('v2-tabular')
    expect(
      desktopRows(mount().container)[0].querySelector('td a span')?.className,
    ).not.toContain('v2-tabular')
  })

  it('renders the address column through the canonical Address component', () => {
    // Not a second truncation rule: the same primitive every address in the
    // app goes through, so the cell cannot diverge from how an address reads
    // anywhere else the reader meets one.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[1].textContent).toMatch(/0x6B17…1d0F/)
    expect(rows[0].querySelectorAll('td')[1].querySelectorAll('.font-mono').length).toBeGreaterThanOrEqual(1)
  })

  it('names at most three paying agents and counts the rest', () => {
    // Three is the issue's number. The fixture's rows are all one-agent, so
    // the cap is exercised on a row derived FROM the fixture — the figures
    // stay the harness's and only the roster moves.
    const five = { ...RECEIPT_ROW, agent_ids: ['agent-research', 'agent-retired', 'a', 'b', 'c'] }
    const { container } = mount([five])
    const cell = desktopRows(container)[0].querySelectorAll('td')[4]
    expect(cell.textContent).toBe('Research agent, Data-feed agent, a and 2 more')
  })

  it('keeps a one-agent row a one-agent row, with no counting clause', () => {
    const { container } = mount()
    expect(desktopRows(container)[0].querySelectorAll('td')[4].textContent).toBe('Research agent')
  })

  it('prints an agent id the roster does not name rather than inventing a name for it', () => {
    // `agents` and `merchants` come off the same query, so an id missing from
    // the roster means the response disagreed with itself. A made-up name
    // would hide the disagreement; the raw id reports it.
    const { container } = mount([{ ...RECEIPT_ROW, agent_ids: ['agent-ghost'] }])
    expect(desktopRows(container)[0].querySelectorAll('td')[4].textContent).toBe('agent-ghost')
  })

  it('says so when the endpoint reports a merchant no agent paid', () => {
    // A bare empty cell reads as "nothing here" and as "unknown" with equal
    // ease. The absence is stated, as every other absence on this page is.
    const { container } = mount([{ ...RECEIPT_ROW, agent_ids: [] }])
    expect(desktopRows(container)[0].querySelectorAll('td')[4].textContent).toBe(
      'No paying agents reported',
    )
  })

  it('states first and last seen as absolute days, with the instant in the title', () => {
    // Absolute rather than relative ("3d ago") on purpose: the fixture's
    // dates are fixed so the capture reads identically on the day it is
    // taken, and "when did this start and stop" is a question about days.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[5].textContent).toBe(formatAnalyticsDay('2026-07-08'))
    expect(rows[0].querySelectorAll('td')[6].textContent).toBe(formatAnalyticsDay('2026-07-10'))
    // The day for reading, the instant for checking.
    expect(rows[0].querySelectorAll('td')[5].querySelector('span[title]')).not.toBeNull()
    // A one-day relationship says the same day twice rather than pretending
    // one date is a range — the two columns report what they are given.
    expect(rows[1].querySelectorAll('td')[5].textContent).toBe(
      rows[1].querySelectorAll('td')[6].textContent,
    )
  })

  it('stages the paying-agents column behind the shell’s own breakpoint', () => {
    // The roster is the column a phone has least need for, so it is the one
    // the primitive's stage ladder retires first — the same token every table
    // in the app uses, not a hand-written breakpoint invented here.
    const { container } = mount()
    const staged = Array.from(container.querySelectorAll('thead th')).filter((th) =>
      th.className.includes('min-width:974px'),
    )
    expect(staged.map((th) => th.textContent)).toEqual(['Paying agents'])
  })
})

describe('MerchantsTable — the mobile rows', () => {
  it('carries the complementary breakpoint classes that make the pair one table', () => {
    // The structural half of the two-renderings rule, and the only half jsdom
    // can see: one container is `hidden lg:block`, the other `lg:hidden`, the
    // same prefix once with `hidden` and once without, so exactly one is
    // displayed at any width.
    const { container } = mount()
    const desktop = desktopOf(container)
    const mobile = mobileOf(container)
    expect(desktop).not.toBeNull()
    expect(mobile).not.toBeNull()
    expect(desktop!.querySelector('table')).not.toBeNull()
    expect(mobile!.querySelector('table')).toBeNull()
    expect(mobile!.querySelectorAll(':scope > div').length).toBe(3)
  })

  it('keeps who, how much and how many on the face of the row', () => {
    // The three a reader at a bus stop is asking about, never behind a
    // disclosure — and every one of them the same field the desktop table
    // prints, so the two layouts cannot disagree about a figure.
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    const text = firstRow.textContent ?? ''
    expect(text).toContain('NordShield VPN')
    expect(text).toContain('$225.00 spent')
    expect(text).toContain('3 payments')
  })

  it('puts the rest of the columns in a disclosure that opens, and is not a second source', async () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement

    expect(within(firstRow).queryByText('Paying agents')).toBeNull()
    const toggle = within(firstRow).getByRole('button', { name: 'More' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    for (const term of ['Address', 'Paying agents', 'First seen', 'Last seen']) {
      expect(within(firstRow).getByText(term)).toBeTruthy()
    }
    expect(within(firstRow).getByText('Research agent')).toBeTruthy()
  })

  it('names the merchant once on the face of the row, not once per open section', () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    expect(within(firstRow).getAllByText('NordShield VPN').length).toBe(1)
  })

  it('truncates an unresolved label on the phone exactly as on the desktop', () => {
    // One data, two layouts: a truncation that exists on one side and not the
    // other is a disagreement between them about who the merchant is.
    const mobile = mobileOf(mount().container)!
    const rows = Array.from(mobile.querySelectorAll(':scope > div'))
    const last = rows[2] as HTMLElement
    expect(within(last).getByText('0x71C2…7128')).toBeTruthy()
    expect(within(last).getByText('0x71C2…7128').getAttribute('title')).toBe(ADDRESS_ROW.address)
  })
})

describe('MerchantsTable — THE LINK TARGET, stated as the issue asks it to be stated', () => {
  it('links to the plain transaction history, because no merchant filter exists there', () => {
    // The issue's rule: `/transactions?merchant=<address>` IF that filter
    // exists, ELSE `/transactions`, and "say which". It does not exist —
    // `TransactionsClient` seeds its filters from `accountId`, `agentId`,
    // `tokenKey` and `direction` alone and reads no `merchant` parameter —
    // so the answer is the second branch, and the exported constant is the
    // rule rather than a string the test re-invents.
    expect(MERCHANTS_LINK_TARGET).toBe('/transactions')

    const { container } = mount()
    const desktopLinks = Array.from(desktopOf(container)!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    expect(desktopLinks).toEqual(['/transactions', '/transactions', '/transactions'])
    for (const href of desktopLinks) expect(href).not.toMatch(/[?&]merchant=/)
  })

  it('links the mobile row to the same plain history, so the two layouts go to one place', () => {
    // The card header, the row and the disclosure all point at the same
    // destination: a filtered-looking link that shows everything would be the
    // page's least honest element, and it would be different on a phone.
    const { container } = mount()
    const mobileLinks = Array.from(mobileOf(container)!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    expect(mobileLinks).toEqual(['/transactions', '/transactions', '/transactions'])
    for (const href of mobileLinks) expect(href).not.toMatch(/[?&]merchant=/)
  })
})

describe('MerchantsTable — the card it lives in, and the copy it is allowed to use', () => {
  it('is titled by what it lists, under a heading, so the capture can wait for it', () => {
    // The harness waits on `Top merchants` for the populated scenario; the
    // heading is what that wait proves arrived, and the page outline is why
    // it is an h2 and not a styled div.
    const { container } = mount()
    expect(container.querySelector('h2')?.textContent).toBe('Top merchants')
  })

  it('renders no rows for an empty list rather than a frame that pretends', () => {
    // The page answers the whole-window case upstream with its own empty
    // state, so a frame here that reported an empty table would be the
    // component disagreeing with the page about whether there is anything.
    const { container } = mount([])
    expect(container.querySelectorAll('tbody tr').length).toBe(0)
    expect(container.textContent).not.toMatch(/No agent activity/)
  })

  it('reports money and never savings, and never calls a refused payment a saving', () => {
    // The copy doctrine of this whole epic in one assertion: a merchant paid
    // is a merchant paid. Nothing on this table may imply that money was
    // kept, and no banned term of the guidelines may appear in it.
    const { container } = mount()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bsaved\b/i)
    expect(text).not.toMatch(/\bsavings\b/i)
    expect(text).not.toMatch(/\bwallet\b/i)
    expect(text).not.toMatch(/\bSafe\b/)
  })

  it('consumes the wire’s numeric strings without re-typing the fixture', () => {
    // The wire-type fidelity note in test form: the rows handed in are still
    // the strings slice B booked (`::text` in SQL, passed through uncoerced),
    // and a figure that failed to parse would print NaN rather than fail.
    expect(typeof RECEIPT_ROW.spent).toBe('string')
    expect(typeof CONTACT_ROW.spent).toBe('string')
    expect(typeof ADDRESS_ROW.spent).toBe('string')
    expect(typeof RECEIPT_ROW.payments).toBe('number')
    const { container } = mount()
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })
})
