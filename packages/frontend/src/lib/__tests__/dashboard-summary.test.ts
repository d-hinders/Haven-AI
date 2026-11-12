import { describe, expect, it } from 'vitest'

import { formatFiat } from '../format'
import {
  buildDashboardSummary,
  buildSinceLastVisitSummary,
  merchantDisplayName,
  sinceLineRepeatsSevenDay,
  type DashboardSummaryInput,
  type SinceLastVisitInput,
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
            // The largest share is 39% — under the 40% naming threshold, so
            // no agent is named and the sentence is a plain count.
            { id: 'a', name: 'Atlas', netSpend: 3.9 },
            { id: 'b', name: 'Robin', netSpend: 3.2 },
            { id: 'c', name: 'Merkel', netSpend: 2.9 },
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
      // Read off the real formatter — sv-SE's separator bytes are the
      // formatter's business, not the sentence's.
    ).toBe(`Atlas spent ${formatFiat(119.46, 'SEK')} at research.example in the last 7 days.`)
  })
})

describe('buildDashboardSummary (#3897) — a week under a cent reads as a count', () => {
  // Each fixture's 7-day total is 0.004: below SUB_CENT_THRESHOLD (0.005),
  // which every money branch keys on — the condition is the input, not the
  // formatted "$0.00" the old sentence printed.
  it('no spending agent on the wire — "Agents made …"', () => {
    expect(
      buildDashboardSummary(
        input({ netSpend: 0.004, payments: 2, distinctMerchants: 1, agents: [{ ...atlas, netSpend: 0 }] }),
      ),
    ).toBe('Agents made 2 payments in the last 7 days.')
  })

  it('one spender — named, with the merchant, and the payment counted', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 0.004,
          payments: 1,
          distinctMerchants: 1,
          agents: [{ ...atlas, netSpend: 0.004 }],
          topMerchant: hostMerchant,
        }),
      ),
    ).toBe('Atlas made 1 payment at research.example in the last 7 days.')
  })

  it('the dominant-agent branch — two names, no "$0.00 of $0.00"', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 0.004,
          payments: 3,
          distinctMerchants: 2,
          agents: [
            { ...atlas, netSpend: 0.003 },
            { ...robin, netSpend: 0.001 },
          ],
        }),
      ),
    ).toBe('Atlas and Robin made 3 payments in the last 7 days.')
  })

  it('three or more spenders — a count, at most two agents named (none here)', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 0.004,
          payments: 22,
          distinctMerchants: 5,
          agents: [
            { ...atlas, netSpend: 0.001 },
            { ...robin, netSpend: 0.001 },
            { ...merkel, netSpend: 0.001 },
            { id: 'd', name: 'Delta', netSpend: 0.001 },
          ],
        }),
      ),
    ).toBe('4 agents made 22 payments in the last 7 days.')
  })

  it('keeps the budget-stop clause on the count form', () => {
    expect(
      buildDashboardSummary(
        input({ netSpend: 0.004, payments: 1, budgetStops: 1, distinctMerchants: 1, agents: [{ ...atlas, netSpend: 0.004 }], topMerchant: hostMerchant }),
      ),
    ).toBe('Atlas made 1 payment at research.example in the last 7 days. 1 payment attempt was stopped by a budget limit.')
  })

  it('at the threshold the money form is back', () => {
    expect(
      buildDashboardSummary(
        input({ netSpend: 0.005, payments: 1, distinctMerchants: 1, agents: [{ ...atlas, netSpend: 0.005 }], topMerchant: hostMerchant }),
      ),
    ).toBe('Atlas spent $0.01 at research.example in the last 7 days.')
  })

  it('the dominant split prints figures only when the agent\'s share is at or above the threshold too', () => {
    // Total 0.007 is above the threshold, Atlas's 0.004 is not: no "spent
    // $0.0040 of $0.0070" — the spread-out count form takes over.
    expect(
      buildDashboardSummary(
        input({
          netSpend: 0.007,
          payments: 2,
          distinctMerchants: 2,
          agents: [
            { ...atlas, netSpend: 0.004 },
            { ...robin, netSpend: 0.003 },
          ],
        }),
      ),
    ).toBe('2 agents spent $0.01 in the last 7 days.')
  })

  it('the dominant split still names the share when both figures are at or above the threshold', () => {
    expect(
      buildDashboardSummary(
        input({
          netSpend: 0.04,
          payments: 2,
          distinctMerchants: 2,
          agents: [
            { ...atlas, netSpend: 0.03 },
            { ...robin, netSpend: 0.01 },
          ],
        }),
      ),
    ).toBe('Atlas spent $0.03 of $0.04 in the last 7 days; Robin spent the rest.')
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

// ── #4709: "Since your last visit" ──────────────────────────────────────────

function sinceInput(overrides: Partial<SinceLastVisitInput> = {}): SinceLastVisitInput {
  return {
    currency: 'USD',
    previous: '2026-11-02T10:00:00.000Z',
    timeWord: 'Since yesterday',
    payments: 0,
    netSpend: 0,
    agents: [],
    ...overrides,
  }
}

const research = { id: 'r', name: 'Research agent', netSpend: 4.2, payments: 3 }
const helper = { id: 'h', name: 'Helper', netSpend: 1.1, payments: 1 }
const atlasSince = { id: 'a', name: 'Atlas', netSpend: 0.5, payments: 1 }

describe('buildSinceLastVisitSummary (#4709) — the exact sentences', () => {
  it('a first ever visit shows no line', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ previous: null, payments: 3, netSpend: 4.2, agents: [research] }),
      ),
    ).toBeNull()
  })

  it('nothing since shows no line', () => {
    expect(buildSinceLastVisitSummary(sinceInput())).toBeNull()
  })

  it('one agent, several payments — the agent is named and the total is shown', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 3, netSpend: 4.2, agents: [research] }),
      ),
    ).toBe('Since yesterday, Research agent made 3 payments for $4.20.')
  })

  it('one payment reads as "1 payment"', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 1, netSpend: 4.2, agents: [{ ...research, payments: 1 }] }),
      ),
    ).toBe('Since yesterday, Research agent made 1 payment for $4.20.')
  })

  it('two agents are both named', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 4, netSpend: 5.3, agents: [research, helper] }),
      ),
    ).toBe('Since yesterday, Research agent and Helper made 4 payments for $5.30.')
  })

  it('three or more agents read as a count — at most two are ever named', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 5, netSpend: 5.8, agents: [research, helper, atlasSince] }),
      ),
    ).toBe('Since yesterday, 3 agents made 5 payments for $5.80.')
  })

  it('a total under a cent reads as a count, never as $0.00', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 3, netSpend: 0.004, agents: [{ ...research, netSpend: 0.004 }] }),
      ),
    ).toBe('Since yesterday, Research agent made 3 payments.')
  })

  it('a net at or below zero reads as a count — a negative figure is not a spend', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 2, netSpend: -1.5, agents: [{ ...research, netSpend: -1.5 }] }),
      ),
    ).toBe('Since yesterday, Research agent made 2 payments.')
  })

  it('renders in the display currency, not a hardcoded one', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ currency: 'SEK', payments: 3, netSpend: 44.2, agents: [{ ...research, netSpend: 44.2 }] }),
      ),
      // Read off the real formatter — sv-SE's separator bytes are the
      // formatter's business, not the sentence's.
    ).toBe(`Since yesterday, Research agent made 3 payments for ${formatFiat(44.2, 'SEK')}.`)
  })

  it('names the agents by net spend, largest first', () => {
    expect(
      buildSinceLastVisitSummary(
        sinceInput({ payments: 2, netSpend: 5.3, agents: [helper, research] }),
      ),
    ).toBe('Since yesterday, Research agent and Helper made 2 payments for $5.30.')
  })

  it('never names a raw address — only agent names reach the sentence', () => {
    const sentence = buildSinceLastVisitSummary(
      sinceInput({
        payments: 1,
        netSpend: 1,
        agents: [{ id: 'x', name: 'Research agent', netSpend: 1, payments: 1 }],
      }),
    )
    expect(sentence).not.toMatch(/0x[0-9a-fA-F]{6,}/)
  })
})

describe('sinceLineRepeatsSevenDay (#4839)', () => {
  // The overview's 7-day window: [start, start + 7×24 h).
  const START = '2026-11-05T12:00:00.000Z'
  const END_MS = Date.parse(START) + 7 * 24 * 60 * 60 * 1000
  const inside = { after: '2026-11-11T09:00:00.000Z', through: '2026-11-12T09:00:00.000Z' }
  const repeats = (o: Partial<Parameters<typeof sinceLineRepeatsSevenDay>[0]> & { payments?: number } = {}) =>
    sinceLineRepeatsSevenDay({
      since: { ...inside, payments: o.payments ?? 3 },
      activityWindowStart: START,
      sevenDayPayments: 3,
      ...o,
    })

  it('window inside the 7-day window with equal counts: it repeats, so it is hidden', () => {
    expect(repeats()).toBe(true)
  })

  it('window inside, fewer payments since: it adds something, so it shows', () => {
    expect(repeats({ payments: 2 })).toBe(false)
  })

  it('window inside, MORE payments since than the 7-day read (the overview predates the entry): shows', () => {
    expect(repeats({ payments: 4 })).toBe(false)
  })

  it('window starting before the 7-day window (too old, or slid on a long-open tab), equal counts: shows', () => {
    expect(repeats({ since: { after: '2026-11-05T11:59:59.999Z', through: inside.through, payments: 3 } })).toBe(false)
    // Exactly on the start is inside: d7 includes its start.
    expect(repeats({ since: { after: START, through: inside.through, payments: 3 } })).toBe(true)
  })

  it('window ending at or after the 7-day window end, equal counts: shows', () => {
    const atEnd = new Date(END_MS).toISOString()
    expect(repeats({ since: { after: inside.after, through: atEnd, payments: 3 } })).toBe(false)
    expect(repeats({ since: { after: inside.after, through: new Date(END_MS - 1).toISOString(), payments: 3 } })).toBe(true)
  })

  it('honours the overview window length when it is on the wire', () => {
    const throughDay8 = new Date(END_MS + 12 * 60 * 60 * 1000).toISOString()
    expect(repeats({ since: { after: inside.after, through: throughDay8, payments: 3 } })).toBe(false)
    expect(repeats({ since: { after: inside.after, through: throughDay8, payments: 3 }, activityWindowDays: 8 })).toBe(true)
  })

  it('anything missing or unparseable: never hidden, the line behaves as before', () => {
    expect(repeats({ since: null })).toBe(false)
    expect(repeats({ activityWindowStart: undefined })).toBe(false)
    expect(repeats({ activityWindowStart: 'not a date' })).toBe(false)
    expect(repeats({ sevenDayPayments: undefined })).toBe(false)
    expect(repeats({ since: { after: 'garbage', through: inside.through, payments: 3 } })).toBe(false)
  })
})

