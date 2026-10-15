import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HowToBuyPanel } from '../HowToBuyPanel'
import type { BudgetAgent } from '@/lib/marketplace'
import type { CatalogEntry, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

/**
 * The "How to buy" panel (#4005): each step reflects the user's real state,
 * read from the wires the page already loads. The fixtures are wire-shaped
 * (typed against the hook return types), mirroring `lib/__tests__`'s #4004
 * set: real Base USDC address, atomic amounts, the #2295 unknown-is-silent
 * rule. The helper's own truth table is pinned in `marketplace.test.ts`;
 * this file pins what the panel RENDERS for each state, including the
 * never-claims rules (a failed agents read, loading skeletons, later steps).
 */

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAY_TO = `0x${'ab'.repeat(40)}`

const funding: MerchantFundingTarget[] = [
  { network: 'eip155:84532', chain_id: 84532, pay_to: PAY_TO, pay_to_status: 'verified', erc7710: true },
]

const atlas: BudgetAgent = {
  id: 'agent-1',
  name: 'Atlas',
  status: 'active',
  account_chain_id: 84532,
  allowances: [
    { id: 'alw-1', agent_id: 'agent-1', token_address: USDC, token_symbol: 'USDC', allowance_amount: '25.00', reset_period_min: 10080 },
  ],
  receivedSubBudgets: [],
}

function offer(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'offer-1',
    name: 'Joke',
    description: 'Returns a joke.',
    category: 'api',
    resource_url: 'https://services.example/api/joke',
    merchant: { id: 'm-1', slug: 'merchant-example', name: 'Merchant Example', listing_status: 'live', is_test_merchant: false },
    rail: 'x402',
    protocol: 'http',
    tool_name: null,
    tool_arguments: null,
    tool_arguments_schema: null,
    http_method: null,
    body_type: null,
    body_example: null,
    price_display: '$0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:84532',
    asset_transfer_methods: null,
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: true,
    ...overrides,
  }
}

function budgetRow(overrides: Partial<DashboardBudgetRemainingEntry> = {}): DashboardBudgetRemainingEntry {
  return {
    agent_id: 'agent-1',
    chain_id: 84532,
    delegation_hash: `0x${'1'.repeat(64)}`,
    token_address: USDC,
    token_symbol: 'USDC',
    token_decimals: 6,
    budget_atomic: '25000000',
    read_at: null,
    period_end: new Date(Date.now() + 86_400_000).toISOString(),
    remaining_atomic: '20000000',
    remaining_from_chain: true,
    used_atomic: '5000000',
    sub_budget_spend: [],
    ...overrides,
  }
}

function merchantBudgetRow(overrides: Partial<MerchantBudget> = {}): MerchantBudget {
  return {
    agent_id: 'agent-1',
    agent_name: 'Atlas',
    chain_id: 84532,
    // Base Sepolia USDC — the offer's token is resolved by ADDRESS through the
    // chain registry, so the wire's token_address must be the 84532 one.
    token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    recipient_address: PAY_TO,
    delegation_hash: `0x${'2'.repeat(64)}`,
    budget_atomic: '25000000',
    period_seconds: 604_800,
    expires_at: String(Math.floor(Date.now() / 1000) + 30 * 86_400),
    remaining_atomic: '20000000',
    remaining_is_from_chain: true,
    pin_status: 'current',
    ...overrides,
  } as MerchantBudget
}

const baseProps = {
  merchantName: 'Merchant Example',
  offers: [offer()],
  agents: [] as BudgetAgent[],
  agentsLoading: false,
  agentsError: null as string | null,
  budgets: [] as DashboardBudgetRemainingEntry[],
  budgetsPending: false,
  budgetsError: null as string | null,
  merchantBudgets: [] as MerchantBudget[],
  funding,
  fundActionAvailable: false,
  onSetBudget: vi.fn(),
  onRetryBudgets: vi.fn(),
}

function step(n: number) {
  return within(screen.getByTestId(`how-to-buy-step-${n}`))
}

/** The step's whole text — the bodies mix elements, so assertions read textContent. */
function stepText(n: number) {
  return screen.getByTestId(`how-to-buy-step-${n}`).textContent
}

describe('HowToBuyPanel', () => {
  it('no active agents: step 1 is open with the /agents link; steps 2 and 3 are later steps claiming nothing', () => {
    render(<HowToBuyPanel {...baseProps} />)
    expect(step(1).getByText('Connect an agent to buy from Merchant Example.')).toBeDefined()
    expect(step(1).getByRole('link', { name: 'Go to Agents' }).getAttribute('href')).toBe('/agents')
    // Later steps describe, never claim.
    expect(step(2).getByText('Once an agent is connected, it needs a budget it can spend here.')).toBeDefined()
    expect(step(2).queryByRole('button')).toBeNull()
    expect(step(3).getByText(/paste it into your agent's chat/)).toBeDefined()
  })

  it('a failed agents read never renders "Connect an agent"', () => {
    render(<HowToBuyPanel {...baseProps} agentsError="boom" />)
    expect(step(1).getByText("Haven couldn't load your agents.")).toBeDefined()
    expect(step(1).queryByText(/Connect an agent to buy from/)).toBeNull()
  })

  it('while agents load the steps are skeletons that claim nothing', () => {
    render(<HowToBuyPanel {...baseProps} agentsLoading />)
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(step(1).queryByText(/Connect an agent to buy from/)).toBeNull()
  })

  it('while the budget wires load, step 2 is a skeleton and claims nothing', () => {
    render(<HowToBuyPanel {...baseProps} agents={[atlas]} budgetsPending />)
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText(/left of/)).toBeNull()
  })

  it('a failed budget read is a retryable line, and retrying refetches both wires', () => {
    const onRetryBudgets = vi.fn()
    render(<HowToBuyPanel {...baseProps} agents={[atlas]} budgetsError="boom" onRetryBudgets={onRetryBudgets} />)
    expect(screen.getByText(/Haven couldn't check budgets — try again./)).toBeDefined()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(onRetryBudgets).toHaveBeenCalledTimes(1)
  })

  it('an agent that can pay: all three steps read done or ready, and step 2 names the agent and its remaining amount', () => {
    render(<HowToBuyPanel {...baseProps} agents={[atlas]} budgets={[budgetRow()]} />)
    // The offer is bridge-only and the paying budget is open: "can pay anyone".
    expect(step(1).getByText('Atlas is connected on Base Sepolia.')).toBeDefined()
    expect(step(2).getByText('Give it a budget it can spend here')).toBeDefined()
    expect(stepText(2)).toContain(
      'Atlas has 20 USDC left of 25 USDC this week, and can pay anyone — so it can pay Merchant Example.',
    )
    expect(stepText(2)).toContain("A budget limited to one recipient can't pay Merchant Example")
    expect(step(2).queryByRole('button')).toBeNull()
    // Step 3 names the agent the panel just claimed can pay.
    expect(stepText(3)).toContain("paste it into Atlas's chat")
    expect(step(3).getByRole('link', { name: 'Transactions' }).getAttribute('href')).toBe('/transactions')
  })

  it('names the merchant-locked budget that pays, without the any-recipient appendix when the offers advertise erc7710', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[atlas]}
        budgets={[]}
        merchantBudgets={[merchantBudgetRow()]}
        offers={[offer({ asset_transfer_methods: 'eip3009,erc7710' })]}
      />,
    )
    expect(stepText(2)).toContain('Atlas has 20 USDC left of 25 USDC this week, and can pay only Merchant Example.')
    expect(stepText(2)).not.toContain('any-recipient')
  })

  it('says "for some offers" when the agent cannot pay every offer, and carries the mixed-merchant tag line', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[atlas]}
        budgets={[budgetRow()]}
        offers={[
          offer({ asset_transfer_methods: null }),
          // On ANOTHER chain: the agent cannot pay it, so the merchant-level
          // answer is partial even though the first offer pays.
          offer({ id: 'o-2', asset_transfer_methods: 'eip3009,erc7710', network: 'eip155:8453' }),
        ]}
      />,
    )
    expect(stepText(2)).toContain('so it can pay Merchant Example for some offers.')
    expect(stepText(2)).toContain('The offers marked "any-recipient budget" need a budget that can pay anyone.')
  })

  it('no budget: step 2 names the fix — the fund action when available, else a link to the agent page', () => {
    const onSetBudget = vi.fn()
    const { unmount } = render(
      <HowToBuyPanel {...baseProps} agents={[atlas]} fundActionAvailable onSetBudget={onSetBudget} />,
    )
    expect(stepText(2)).toContain('Atlas has no budget that can pay Merchant Example yet.')
    screen.getByRole('button', { name: 'Set a budget for this merchant' }).click()
    expect(onSetBudget).toHaveBeenCalledTimes(1)
    unmount()

    render(<HowToBuyPanel {...baseProps} agents={[atlas]} />)
    expect(stepText(2)).toContain('Atlas has no budget that can pay Merchant Example yet.')
    expect(step(2).getByRole('link', { name: /Atlas's page/ }).getAttribute('href')).toBe('/agents/agent-1')
  })

  it('a budget locked to another recipient is no budget that can pay here — the same fix is named', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[atlas]}
        budgets={[budgetRow({ recipient_address: `0x${'cd'.repeat(20)}` })]}
      />,
    )
    expect(stepText(2)).toContain('Atlas has no budget that can pay Merchant Example yet.')
  })

  it('nothing left this period: step 2 names what is left and points at the agent page', () => {
    render(<HowToBuyPanel {...baseProps} agents={[atlas]} budgets={[budgetRow({ remaining_atomic: '1000' })]} />)
    expect(stepText(2)).toContain('Atlas has 0.001 USDC left of 25 USDC this week — not enough for any offer here.')
    expect(step(2).getByRole('link', { name: /Atlas's page/ })).toBeDefined()
  })

  it('wrong network: the step says so plainly, with no fix button', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[{ ...atlas, account_chain_id: 8453, allowances: [] }]}
        budgets={[]}
        offers={[offer()]}
      />,
    )
    expect(stepText(2)).toContain(
      "Atlas's Haven wallet is on Base — this merchant's offers are on Base Sepolia. Haven can't add a second account from here.",
    )
    expect(step(2).queryByRole('button')).toBeNull()
    expect(step(2).queryByRole('link')).toBeNull()
  })

  it('several active agents: step 1 shows the count and names one', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[atlas, { ...atlas, id: 'agent-2', name: 'Blinks', allowances: [] }]}
        budgets={[]}
      />,
    )
    expect(step(1).getByText('Atlas is connected on Base Sepolia, along with 1 more agent.')).toBeDefined()
  })

  it('unknown answers claim nothing — the panel never guesses', () => {
    render(
      <HowToBuyPanel
        {...baseProps}
        agents={[{ ...atlas, allowances: [], receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'P', open: true }] }]}
        budgets={[]}
      />,
    )
    expect(step(2).getByText(/Haven couldn't confirm what your agent can spend here just now\./)).toBeDefined()
    expect(step(2).queryByRole('button')).toBeNull()
  })
})
