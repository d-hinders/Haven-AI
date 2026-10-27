import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MerchantsTable, merchantsLinkTarget } from '../MerchantsTable'
import type { AnalyticsAgentRow, AnalyticsMerchantRow } from '@/types/analytics'
import { formatAnalyticsAmount } from '@/lib/analytics-format'
import { seriesColorForAgent } from '@/lib/avatar-tint'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../../scripts/screenshot.mjs'

/**
 * The top merchants table (#2949, epic #2944 slice E; the #4333 rebuild).
 *
 * Four rules the component is built on and every one of them is pinned here:
 *
 *   1. the ranking is the endpoint's, inherited not chosen;
 *   2. the label is the API's resolution and the table never re-resolves it —
 *      and since #4333 a null label reads "Unknown recipient" with the kind
 *      line under it; NO cell renders a `0x…` address AS the label;
 *   3. the figures are the wire's, formatted at the edge and never recomputed;
 *   4. "View in Transactions" carries the filter (#4333): `search=` the
 *      address `/transactions` matches, `direction=out`, the page's current
 *      `period`, and `agentId` when the Agent facet is set — read through
 *      `merchantsLinkTarget`, not re-stated here.
 *
 * Fixtures are the CAPTURE HARNESS's own rows, imported exactly as
 * `AgentsTable.test.tsx` imports them. jsdom applies no stylesheet, so the
 * two-renderings rule is pinned STRUCTURALLY, as the agents suite does it.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

const MERCHANTS = FIXTURE_ANALYTICS_OVERVIEW.merchants as unknown as AnalyticsMerchantRow[]
const AGENTS = FIXTURE_ANALYTICS_OVERVIEW.agents as unknown as AnalyticsAgentRow[]

/** The three rows the harness declares: contact, receipt name, unknown. */
const [CONTACT_ROW, RECEIPT_ROW, UNKNOWN_ROW] = MERCHANTS

function mount(merchants: AnalyticsMerchantRow[] = MERCHANTS, agentId: string | null = null) {
  const view = render(
    <MerchantsTable merchants={merchants} agents={AGENTS} currency="USD" period="30d" agentId={agentId} />,
  )
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

describe('MerchantsTable — the desktop table (#4333 columns)', () => {
  it('names every column the rebuild defines, in the order the reader scans them', () => {
    const { container } = mount()
    const heads = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)
    expect(heads).toEqual([
      'Paid to',
      'Spent',
      'Payments',
      'Paid by',
      'Last paid',
      'View in Transactions',
    ])
  })

  it('renders one row per merchant, in the order the endpoint sent them', () => {
    // The NAME span inside the label cell (the kind line rides under it).
    const { container } = mount()
    const firstCells = desktopRows(container).map(
      (tr) => tr.querySelectorAll('td')[0].querySelector('span.font-medium')?.textContent,
    )
    expect(firstCells).toEqual(['NordShield VPN', 'Klara Data AB', 'Unknown recipient'])
  })

  it('renders the booked figures through the shared formatters, not as raw fields', () => {
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[1].textContent).toBe(formatAnalyticsAmount('225.00', 'USD'))
    expect(rows[1].querySelectorAll('td')[1].textContent).toBe(formatAnalyticsAmount('87.25', 'USD'))
    expect(rows[2].querySelectorAll('td')[1].textContent).toBe(formatAnalyticsAmount('12.50', 'USD'))
    // Payments is one of B's number-typed counts: printed as the integer it
    // is, with no currency and no grouping attached to it.
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe('3')
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe('1')
  })

  it('carries the kind line: Your account, Paid API, or the short address for an unknown', () => {
    // #4333: the kind line names the naming step that produced the label. An
    // UNKNOWN recipient's short address is deliberately the kind line — the
    // address is metadata, never the label.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[0].textContent).toContain('NordShield VPN') // contact: no kind line
    expect(rows[1].querySelectorAll('td')[0].textContent).toContain('Klara Data AB') // receipt: no kind line
    const unknown = rows[2].querySelectorAll('td')[0]
    expect(unknown.textContent).toContain('Unknown recipient')
    expect(unknown.textContent).toContain('0x71C2…7128')
  })

  it('carries a Your account / Paid API kind line when the API resolved one of those', () => {
    const ownAccount = desktopRows(
      mount([{ ...CONTACT_ROW, label: 'My Hot Wallet', kind: 'own_account' as const }]).container,
    )[0].querySelectorAll('td')[0]
    expect(ownAccount.textContent).toContain('Your account')
    const paidApi = desktopRows(
      mount([{ ...CONTACT_ROW, label: 'api.example.com', kind: 'x402' as const }]).container,
    )[0].querySelectorAll('td')[0]
    expect(paidApi.textContent).toContain('Paid API')
  })

  it('never renders a 0x… address AS the label, and keeps the full address in the tooltip', () => {
    // The no-0x-label test the issue asks for: the NAME cell of every row,
    // across both tables' label rules.
    const rows = desktopRows(mount().container)
    for (const row of rows) {
      const name = row.querySelectorAll('td')[0].querySelector('span')!.textContent ?? ''
      expect(name).not.toMatch(/^0x[0-9a-fA-F]/)
    }
    // The unknown row's NAME span reads "Unknown recipient" — the short
    // address is the kind line UNDER it, by design; the full address is the
    // tooltip and the mobile disclosure, never the label.
    const nameSpan = rows[2].querySelectorAll('td')[0].querySelector('span.font-medium')
    expect(nameSpan?.textContent).toBe('Unknown recipient')
  })

  it('renders the paying agents as the shared avatar stack, capped at three with a +N mark', () => {
    // Three is the issue's number. The fixture's rows are all one-agent, so
    // the cap is exercised on a row derived FROM the fixture.
    const five = { ...RECEIPT_ROW, agent_ids: ['agent-research', 'agent-retired', 'a', 'b', 'c'] }
    const { container } = mount([five])
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    const stack = cell.querySelector('[data-testid="agent-avatar-stack"]')
    expect(stack).not.toBeNull()
    expect(cell.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(3)
    expect(cell.querySelector('[data-testid="agent-avatar-stack-overflow"]')?.textContent).toBe('+2')
    // The names live in the stack's accessible name, never as visible text.
    expect(stack!.getAttribute('aria-label')).toBe('Research agent, Data-feed agent, a and 2 more')
    expect(cell.textContent).not.toContain('Research agent')
  })

  it('keeps a one-agent row a one-agent row, with no counting clause', () => {
    const { container } = mount()
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    expect(cell.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(1)
    expect(cell.querySelector('[data-testid="agent-avatar-stack-overflow"]')).toBeNull()
    expect(cell.querySelector('[data-testid="agent-avatar-stack"]')?.getAttribute('aria-label')).toBe(
      'Research agent',
    )
  })

  it('renders a three-agent row as three marks and no overflow', () => {
    // The cap's boundary: three is still three marks, not two and a "+1".
    const three = { ...RECEIPT_ROW, agent_ids: ['agent-research', 'agent-retired', 'agent-ghost'] }
    const { container } = mount([three])
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    expect(cell.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(3)
    expect(cell.querySelector('[data-testid="agent-avatar-stack-overflow"]')).toBeNull()
    expect(cell.querySelector('[data-testid="agent-avatar-stack"]')?.getAttribute('aria-label')).toBe(
      'Research agent, Data-feed agent, agent-ghost',
    )
  })

  it('wears each agent’s STORED tint, so two names that hash alike still differ — and each equals its chart series colour', () => {
    // 'Research agent' and 'Data-feed agent' hash to the SAME tint (6), so a
    // hash-only stack would paint them one colour. The fixture stores 1 and 2,
    // and the marks must wear those — the same tokens `seriesColorForAgent`
    // fills their chart series with (#4331/#4428). `Monogram` carries no data
    // attribute, so the tint is read from its ink class.
    const { container } = mount([{ ...RECEIPT_ROW, agent_ids: ['agent-research', 'agent-retired'] }])
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    const marks = Array.from(cell.querySelectorAll('[data-testid="agent-avatar-stack-mark"]'))
    const inks = marks.map((mark) => mark.querySelector('span')?.className ?? '')
    const research = seriesColorForAgent({ name: 'Research agent', avatarTint: 1 })
    const dataFeed = seriesColorForAgent({ name: 'Data-feed agent', avatarTint: 2 })
    expect(research).not.toBe(dataFeed)
    expect(inks[0]).toContain(`text-[${research}]`)
    expect(inks[1]).toContain(`text-[${dataFeed}]`)
  })

  it('prints an agent id the roster does not name rather than inventing a name for it', () => {
    // `agents` and `merchants` come off the same query, so an id missing from
    // the roster means the response disagreed with itself. A made-up name
    // would hide the disagreement; the raw id reports it — as the mark's
    // accessible name, with no stored tint (the name hash).
    const { container } = mount([{ ...RECEIPT_ROW, agent_ids: ['agent-ghost'] }])
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    expect(cell.querySelector('[data-testid="agent-avatar-stack"]')?.getAttribute('aria-label')).toBe(
      'agent-ghost',
    )
    expect(cell.textContent).not.toContain('Research agent')
    const ink = cell.querySelector('[data-testid="agent-avatar-stack-mark"] span')?.className ?? ''
    expect(ink).toContain(`text-[${seriesColorForAgent({ name: 'agent-ghost' })}]`)
  })

  it('says so when the endpoint reports a merchant no agent paid', () => {
    // There is no empty stack: the sentence is the caller's, and it stays.
    const { container } = mount([{ ...RECEIPT_ROW, agent_ids: [] }])
    const cell = desktopRows(container)[0].querySelectorAll('td')[3]
    expect(cell.textContent).toBe('No paying agents reported')
    expect(cell.querySelector('[data-testid="agent-avatar-stack"]')).toBeNull()
  })

  it('states last paid through the same relative voice the agents table uses', () => {
    // One dialect for "how recently" across the page's two tables; the full
    // instant rides the title.
    const rows = desktopRows(mount().container)
    expect(rows[0].querySelectorAll('td')[4].querySelector('span[title]')).not.toBeNull()
    expect(rows[0].querySelectorAll('td')[4].textContent).toMatch(/ago|Never|No payments/)
  })

  it('stages Paid by at the md container width and the action at xl', () => {
    // Paid by moved from `xl` (974px) to `md` (718px) in #4481: the stack is
    // narrower than the roster line it replaced, and at the `lg` viewport the
    // table is 720px wide (1024 − 240px sidebar − 64px page padding), so `md`
    // reveals it exactly where the phone disclosure stops — no width where
    // neither surface shows paying agents. View in Transactions stays at `xl`:
    // it is an action, not a figure.
    const { container } = mount()
    const heads = Array.from(container.querySelectorAll('thead th'))
    const stagedAt = (px: string) =>
      heads.filter((th) => th.className.includes(`min-width:${px}px`)).map((th) => th.textContent)
    expect(stagedAt('718')).toEqual(['Paid by'])
    expect(stagedAt('974')).toEqual(['View in Transactions'])
  })
})

describe('MerchantsTable — the mobile rows', () => {
  it('carries the complementary breakpoint classes that make the pair one table', () => {
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
    for (const term of ['Address', 'Paying agents', 'First seen', 'Last paid']) {
      expect(within(firstRow).getByText(term)).toBeTruthy()
    }
    expect(within(firstRow).getByText('Research agent')).toBeTruthy()
    // The phone keeps the TEXT roster (#4481): no stack in the disclosure.
    expect(firstRow.querySelector('[data-testid="agent-avatar-stack"]')).toBeNull()
  })

  it('names the merchant once on the face of the row, not once per open section', () => {
    const mobile = mobileOf(mount().container)!
    const firstRow = mobile.querySelector('div') as HTMLElement
    expect(within(firstRow).getAllByText('NordShield VPN').length).toBe(1)
  })

  it('reads Unknown recipient on the phone exactly as on the desktop, with the address in the disclosure', () => {
    // One data, two layouts: a label rule that differed per width would be
    // two answers to who the merchant is.
    const mobile = mobileOf(mount().container)!
    const rows = Array.from(mobile.querySelectorAll(':scope > div'))
    const last = rows[2] as HTMLElement
    expect(within(last).getByText('Unknown recipient')).toBeTruthy()
    expect(within(last).getByText('0x71C2…7128')).toBeTruthy() // the kind line
    expect(within(last).queryByText(/^0x71C2E8/)).toBeNull() // full address only in the disclosure
  })
})

describe('MerchantsTable — THE LINK TARGET, stated as the issue asks it to be stated (#4333)', () => {
  it('links to /transactions pre-filtered: search= the matched address, direction=out, period', () => {
    // `search` is the key `parseTransactionFilters` reads
    // (`lib/transaction-filters.ts`), and `filter_address` is the address
    // that page's search matches — the wire's field for exactly this.
    expect(merchantsLinkTarget(UNKNOWN_ROW.filter_address, '30d', null)).toBe(
      `/transactions?search=${UNKNOWN_ROW.filter_address}&direction=out&period=30d`,
    )
    const { container } = mount()
    const desktopLinks = Array.from(desktopOf(container)!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    expect(desktopLinks).toHaveLength(6) // label link + View in Transactions, per row
    for (const href of desktopLinks) {
      expect(href).toContain('/transactions?search=')
      expect(href).toContain('direction=out')
      expect(href).toContain('period=30d')
    }
  })

  it('carries the Agent facet\u2019s agentId onto the link when the page is filtered', () => {
    expect(merchantsLinkTarget(UNKNOWN_ROW.filter_address, '7d', 'agent-research')).toBe(
      `/transactions?search=${UNKNOWN_ROW.filter_address}&direction=out&period=7d&agentId=agent-research`,
    )
    const { container } = mount(MERCHANTS, 'agent-research')
    const hrefs = Array.from(desktopOf(container)!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    for (const href of hrefs) expect(href).toContain('&agentId=agent-research')
  })

  it('links the mobile row to the same filtered history, so the two layouts go to one place', () => {
    const { container } = mount(MERCHANTS, 'agent-retired')
    const mobileLinks = Array.from(mobileOf(container)!.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    )
    for (const href of mobileLinks) {
      expect(href).toContain('/transactions?search=')
      expect(href).toContain('&agentId=agent-retired')
    }
  })
})

describe('MerchantsTable — the card it lives in, and the copy it is allowed to use', () => {
  it('is titled by what it lists, under a heading, so the capture can wait for it', () => {
    const { container } = mount()
    expect(container.querySelector('h2')?.textContent).toBe('Top merchants')
  })

  it('renders no rows for an empty list rather than a frame that pretends', () => {
    const { container } = mount([])
    expect(container.querySelectorAll('tbody tr').length).toBe(0)
    expect(container.textContent).not.toMatch(/No agent activity/)
  })

  it('reports money and never savings, and never calls a refused payment a saving', () => {
    const { container } = mount()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bsaved\b/i)
    expect(text).not.toMatch(/\bsavings\b/i)
    expect(text).not.toMatch(/\bwallet\b/i)
    expect(text).not.toMatch(/\bSafe\b/)
  })

  it('consumes the wire’s numeric strings without re-typing the fixture', () => {
    expect(typeof RECEIPT_ROW.spent).toBe('string')
    expect(typeof CONTACT_ROW.spent).toBe('string')
    expect(typeof UNKNOWN_ROW.spent).toBe('string')
    expect(typeof RECEIPT_ROW.payments).toBe('number')
    const { container } = mount()
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })
})
