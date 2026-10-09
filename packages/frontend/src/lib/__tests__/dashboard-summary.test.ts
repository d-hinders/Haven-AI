import { describe, expect, it } from 'vitest'

import {
  buildDashboardSummary,
  merchantDisplayName,
  type DashboardSummaryInput,
} from '../dashboard-summary'

function input(overrides: Partial<DashboardSummaryInput> = {}): DashboardSummaryInput {
  return {
    currency: 'USD',
    netSpend: 0,
    payments: 0,
    budgetStops: 0,
    distinctMerchants: 0,
    agents: [],
    topMerchant: null,
    ...overrides,
  }
}

const atlas = { id: 'a', name: 'Atlas', netSpend: 11.1 }
const robin = { id: 'b', name: 'Robin', netSpend: 2.4 }
const merkel = { id: 'c', name: 'Merkel', netSpend: 1.6 }

const hostMerchant = {
  key: 'research.example',
  x402ResourceUrl: 'https://research.example/report',
  to: '0x3333333333333333333333333333333333333333',
  merchantName: null,
}

describe('buildDashboardSummary (#3807) — the exact sentences', () => {
  it('no payments, no stops', () => {
    expect(buildDashboardSummary(input())).toBe(
      'No agent payments in the last 7 days.',
    )
  })

  it('one agent and one merchant — the agent and the merchant host are named', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 11.1,
          payments: 4,
          distinctMerchants: 1,
          agents: [atlas],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('Atlas spent $11.10 at research.example in the last 7 days.')
  })

  it('one agent and several merchants — a count, never a guessed name', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 11.1,
          payments: 9,
          distinctMerchants: 3,
          agents: [atlas],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('Atlas spent $11.10 across 3 merchants in the last 7 days.')
  })

  it('several agents with one at ≥ 40% of spend — the dominant agent is named beside its share', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 12,
          payments: 12,
          distinctMerchants: 4,
          agents: [
            { id: 'a', name: 'Atlas', netSpend: 8 },
            { id: 'b', name: 'Robin', netSpend: 4 },
          ],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('Atlas spent $8.00 of $12.00 in the last 7 days; Robin spent the rest.')
  })

  it('several agents spread out — a count, no agent above the naming threshold', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 10,
          payments: 12,
          distinctMerchants: 4,
          agents: [
            { id: 'a', name: 'Atlas', netSpend: 4 },
            { id: 'b', name: 'Robin', netSpend: 3.2 },
            { id: 'c', name: 'Merkel', netSpend: 2.8 },
          ],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('3 agents spent $10.00 in the last 7 days.')
  })

  it('only budget stops — the week is summarized by what it refused, neutrally', () => {
    expect(
      buildDashboardSummary(input({ payments: 0, budgetStops: 2 })),
    ).toBe(
      'No agent payments went through in the last 7 days. 2 payment attempts were stopped by a budget limit.',
    )
  })

  it('a stop clause rides along when payments went through too', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 11.1,
          payments: 4,
          budgetStops: 1,
          distinctMerchants: 1,
          agents: [atlas],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe(
      'Atlas spent $11.10 at research.example in the last 7 days. 1 payment attempt was stopped by a budget limit.',
    )
  })

  it('never says "within budget" — the phrase carries no information', () => {
    const sentence = buildDashboardSummary(input({ payments: 0, budgetStops: 5 }))
    expect(sentence).not.toMatch(/within budget/i)
  })

  it('several spenders name at most two agents, counting the rest', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 12,
          payments: 20,
          distinctMerchants: 2,
          agents: [
            { id: 'a', name: 'Atlas', netSpend: 6 }, // 50% ≥ 40%
            { id: 'b', name: 'Robin', netSpend: 3 },
            { id: 'c', name: 'Merkel', netSpend: 3 },
          ],
          topMerchant: null,
        }),
      ),
    ).toBe(
      'Atlas spent $6.00 of $12.00 in the last 7 days; Robin and 1 other agent spent the rest.',
    )
  })

  it('a merchant with only a contact name names the contact, not the address', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 5,
          payments: 2,
          distinctMerchants: 1,
          agents: [atlas],
          topMerchant: {
            key: '0x3333333333333333333333333333333333333333',
            x402ResourceUrl: null,
            to: '0x3333333333333333333333333333333333333333',
            merchantName: 'Acme Corp',
          },
        }),
      ),
    ).toBe('Atlas spent $5.00 at Acme Corp in the last 7 days.')
  })

  it('a bare address with no name renders no name at all', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 5,
          payments: 2,
          distinctMerchants: 1,
          agents: [atlas],
          topMerchant: {
            key: '0x3333333333333333333333333333333333333333',
            x402ResourceUrl: null,
            to: '0x3333333333333333333333333333333333333333',
            merchantName: null,
          },
        }),
      ),
    ).toBe('Atlas spent $5.00 across 1 merchant in the last 7 days.')
  })

  it('renders in the display currency, not a hardcoded one', () => {
    expect(
      buildDashboardSummary(
        input({
          currency: 'SEK',
          netSpend: 119.46,
          payments: 4,
          distinctMerchants: 1,
          agents: [{ id: 'a', name: 'Atlas', netSpend: 119.46 }],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('Atlas spent 119,46 kr at research.example in the last 7 days.')
  })
})

describe('merchantDisplayName (#3807, #3810 counterparty rules)', () => {
  it('prefers the contact/receipt name', () => {
    expect(
      merchantDisplayName({ ...hostMerchant, merchantName: 'Acme Corp' }),
    ).toBe('Acme Corp')
  })

  it('falls back to the x402 resource HOST', () => {
    expect(merchantDisplayName(hostMerchant)).toBe('research.example')
  })

  it('uses a bare host key when no resource URL exists', () => {
    expect(
      merchantDisplayName({ key: 'shop.example', x402ResourceUrl: null, to: null, merchantName: null }),
    ).toBe('shop.example')
  })

  it('never returns a raw address', () => {
    expect(
      merchantDisplayName({ key: '0xabc', x402ResourceUrl: null, to: '0xabc', merchantName: null }),
    ).toBeNull()
  })
})
