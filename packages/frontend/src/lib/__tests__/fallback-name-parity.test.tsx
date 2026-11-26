/**
 * #4932: every fallback literal the frontend renders for an unnamed
 * counterparty is in `HAVEN_FALLBACK_NAMES` (`@haven_ai/core`) — the ONE list
 * the backend refuses a receipt seller name against
 * (`RECEIPT_MERCHANT_NAMES_SQL`, `infra/repositories/analytics.ts`).
 *
 * The sites import the constants rather than re-typing the string, so a
 * changed literal cannot drift from the list; this suite proves the rendered
 * output is the listed one, which is what a hardcoded replacement would break.
 * The four sites the issue names:
 *
 *   - `counterpartyLabel` (`lib/transaction-presentation.tsx`) — "New
 *     recipient", "Deposit", "Sale" (#5000), "Agent payment", and the
 *     templated "From …" / "Returned from …" / "Sale · …";
 *   - `paymentSourceTitle` (`lib/transaction-labels.ts`) — "Agent payment",
 *     "Machine payment";
 *   - `MerchantsTable` / `AgentsTable` — "Unknown recipient", "None in this
 *     range";
 *   - `TransactionDetailPanel` — "Moved between your accounts", and its
 *     `unnamed` check on "New recipient".
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import {
  HAVEN_FALLBACK_NAME,
  HAVEN_FALLBACK_NAMES,
  HAVEN_FALLBACK_NAME_PREFIXES,
} from '@haven_ai/core'
import { counterpartyLabel, type CounterpartyFields } from '../transaction-presentation'
import { paymentSourceTitle } from '../transaction-labels'
import { MerchantsTable } from '@/components/analytics/MerchantsTable'
import { AgentsTable } from '@/components/analytics/AgentsTable'
import TransactionDetailPanel from '@/components/transactions/TransactionDetailPanel'
import { LocaleProvider } from '@/context/LocaleContext'
import type { AnalyticsAgentRow, AnalyticsMerchantRow } from '@/types/analytics'
import type { AggregatedTransaction } from '@/types/transactions'
import { FIXTURE_ANALYTICS_OVERVIEW } from '../../../scripts/screenshot.mjs'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))

vi.mock('@/hooks/useEscapeToClose', () => ({ useEscapeToClose: vi.fn() }))
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))

const ADDRESS = '0x2222222222222222222222222222222222222222'
const OWN_ACCOUNT = '0x4444444444444444444444444444444444444444'

/** A row that offers the counterparty fields and nothing else. */
function row(overrides: Partial<CounterpartyFields> = {}): CounterpartyFields {
  return {
    activityType: undefined,
    agentName: undefined,
    source: undefined,
    x402ResourceUrl: undefined,
    direction: 'out',
    to: ADDRESS,
    from: OWN_ACCOUNT,
    chainId: 8453,
    recipientName: undefined,
    ...overrides,
  }
}

/** The assertion the whole suite exists for: this literal is Haven's own. */
function expectHavenFallback(label: string): void {
  const listed = (HAVEN_FALLBACK_NAMES as readonly string[]).includes(label)
  const prefixed = HAVEN_FALLBACK_NAME_PREFIXES.some((prefix) => label.startsWith(prefix))
  expect(listed || prefixed, `"${label}" is not a Haven fallback literal`).toBe(true)
}

describe('#4932 — the frontend fallback literals are the core list', () => {
  it('counterpartyLabel: every no-address fallback is a listed literal or a listed prefix', () => {
    const cases: Array<[string, string]> = [
      // a sweep reads "Returned from <agent>"
      ['sweep', counterpartyLabel(row({ activityType: 'delegate_sweep', direction: 'in', agentName: 'Research assistant' }), undefined, undefined, { noAddress: true })],
      // an x402 row with no resource URL falls back to its source title
      ['x402 without a host', counterpartyLabel(row({ source: 'x402' }), undefined, undefined, { noAddress: true })],
      // an inbound row with no own-account sender reads "Deposit"
      ['inbound', counterpartyLabel(row({ direction: 'in' }), undefined, undefined, { noAddress: true })],
      // an outgoing row nothing resolves reads "New recipient"
      ['outgoing unresolved', counterpartyLabel(row(), undefined, undefined, { noAddress: true })],
      // a deposit from another of your own accounts reads "From <account>"
      [
        'deposit from an own account',
        counterpartyLabel(row({ direction: 'in' }), undefined, new Map([[`${OWN_ACCOUNT}:8453`, 'Main']]), {
          noAddress: true,
        }),
      ],
      // #5000: a sale with no recorded product reads "Sale"
      [
        'sale without a product',
        counterpartyLabel(row({ direction: 'in', sale: { productName: null } }), undefined, undefined, { noAddress: true }),
      ],
      // #5000: a recorded sale reads "Sale · <product>"
      [
        'recorded sale',
        counterpartyLabel(row({ direction: 'in', sale: { productName: 'Haven Field Notes' } }), undefined, undefined, {
          noAddress: true,
        }),
      ],
    ]

    for (const [name, label] of cases) {
      expectHavenFallback(label)
      expect(label, name).not.toBe('')
    }
  })

  it('paymentSourceTitle: both machine-payment titles are listed literals', () => {
    expectHavenFallback(paymentSourceTitle('x402')!)
    expectHavenFallback(paymentSourceTitle('mpp_demo')!)
    expect(paymentSourceTitle('x402')).toBe(HAVEN_FALLBACK_NAME.agentPayment)
    expect(paymentSourceTitle('mpp_demo')).toBe(HAVEN_FALLBACK_NAME.machinePayment)
  })

  it('MerchantsTable: an unresolved merchant renders a listed literal, never an address', () => {
    const merchants = FIXTURE_ANALYTICS_OVERVIEW.merchants as unknown as AnalyticsMerchantRow[]
    const agents = FIXTURE_ANALYTICS_OVERVIEW.agents as unknown as AnalyticsAgentRow[]
    const unknown = merchants.find((merchant) => merchant.label === null)
    expect(unknown, 'the fixture carries an unresolved merchant row').toBeDefined()

    const { container } = render(
      <MerchantsTable merchants={[unknown!]} agents={agents} currency="USD" period="30d" />,
    )
    const cells = Array.from(container.querySelectorAll('tbody tr td')).map((td) => td.textContent ?? '')
    const rendered = cells.find((text) => text.includes(HAVEN_FALLBACK_NAME.unknownRecipient))
    expect(rendered, 'the unresolved row renders "Unknown recipient"').toBeDefined()
    expectHavenFallback(HAVEN_FALLBACK_NAME.unknownRecipient)
  })

  it('AgentsTable: both unresolved labels are listed literals', () => {
    const agents = FIXTURE_ANALYTICS_OVERVIEW.agents as unknown as AnalyticsAgentRow[]
    const unresolvedLabel = agents.find((agent) => agent.top_merchant !== null && agent.top_merchant.label === null)
    expect(unresolvedLabel, 'the fixture carries an agent whose top merchant has no label').toBeDefined()
    const noMerchant = { ...agents[0], top_merchant: null } as AnalyticsAgentRow

    render(<AgentsTable agents={[unresolvedLabel!, noMerchant]} currency="USD" />)

    expect(screen.getAllByText(HAVEN_FALLBACK_NAME.unknownRecipient).length).toBeGreaterThan(0)
    expect(screen.getAllByText(HAVEN_FALLBACK_NAME.noneInRange).length).toBeGreaterThan(0)
    expectHavenFallback(HAVEN_FALLBACK_NAME.unknownRecipient)
    expectHavenFallback(HAVEN_FALLBACK_NAME.noneInRange)
  })

  it('TransactionDetailPanel: an unnamed send and a move both render listed literals', () => {
    const unnamed = {
      hash: `0x${'ab'.repeat(32)}`,
      type: 'erc20',
      from: OWN_ACCOUNT,
      to: ADDRESS,
      value: '1000000',
      valueFormatted: '1.00',
      asset: 'USDC',
      decimals: 6,
      direction: 'out',
      timestamp: 1_700_000_000,
      blockNumber: 1,
      isError: false,
      tokenAddress: '0x3333333333333333333333333333333333333333',
      tokenSymbol: 'USDC',
      chainId: 8453,
      accountId: 'acc-main',
      accountAddress: OWN_ACCOUNT,
      accountName: 'Main',
    } as unknown as AggregatedTransaction

    const { unmount } = render(
      <LocaleProvider>
        <TransactionDetailPanel transaction={unnamed} open onClose={vi.fn()} />
      </LocaleProvider>,
    )
    expect(screen.getAllByText(HAVEN_FALLBACK_NAME.newRecipient).length).toBeGreaterThan(0)
    expectHavenFallback(HAVEN_FALLBACK_NAME.newRecipient)
    unmount()

    // A move between your own accounts: the panel's own title, not
    // `counterpartyLabel`'s.
    const move = {
      ...unnamed,
      ownTransfer: true,
      direction: 'out',
      to: OWN_ACCOUNT,
    } as unknown as AggregatedTransaction
    render(
      <LocaleProvider>
        <TransactionDetailPanel transaction={move} open onClose={vi.fn()} />
      </LocaleProvider>,
    )
    expect(screen.getAllByText(HAVEN_FALLBACK_NAME.movedBetweenAccounts).length).toBeGreaterThan(0)
    expectHavenFallback(HAVEN_FALLBACK_NAME.movedBetweenAccounts)
  })
})
