import { describe, expect, it } from 'vitest'
import {
  agentInstruction,
  agentsThatCanPay,
  budgetAnswerLine,
  categoryLabel,
  freshness,
  howToBuy,
  isTestnetChain,
  listsTestnet,
  merchantInitials,
  needsUnpinnedBudget,
  networkToChainId,
  type AgentsThatCanPayInput,
  type BudgetAgent,
  type BudgetAgentAnswer,
} from '@/lib/marketplace'
// #3839: the SDK's discovery hint, by relative path — the frontend keeps no
// @haven_ai/* runtime dependency (standalone Vercel deploys), the same pattern
// agent-onboarding-prompt.test.ts uses for cross-package parity.
import { catalogFundingLegExpected } from '../../../../sdk/src/catalog-funding-leg'
import type { CatalogEntry, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'cat-1',
    name: 'Text generation',
    description: 'Generate text content.',
    category: 'media',
    resource_url: 'https://mcp.merchant.example/mcp',
    merchant: {
      id: 'merchant-1',
      slug: 'merchant-example',
      name: 'Merchant Example',
      listing_status: 'live',
      is_test_merchant: false,
    },
    rail: 'x402',
    protocol: 'mcp',
    tool_arguments: null,
    tool_arguments_schema: null,
    http_method: null,
    body_type: null,
    body_example: null,
    asset_transfer_methods: null,
    tool_name: 'create_text',
    price_display: '0.01 USDC',
    price_atomic: '10000',
    asset: 'USDC',
    network: 'eip155:8453',
    status: 'active',
    verified_at: new Date().toISOString(),
    source: 'operator',
    domain_verified: false,
    verified_payable: false,
    ...overrides,
  }
}

// #4004 — the fixtures below use the REAL Base USDC address: the
// merchant-budgets wire names tokens by address, resolved through
// `getChainTokens`, so a made-up address would silently match nothing.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const NOW_MS = Date.parse('2026-10-15T12:00:00.000Z')
const PAY_TO = `0x${'ab'.repeat(40)}`
const OTHER_PAY_TO = `0x${'cd'.repeat(40)}`

const verifiedFunding: MerchantFundingTarget = {
  network: 'eip155:8453',
  chain_id: 8453,
  pay_to: PAY_TO,
  pay_to_status: 'verified',
  erc7710: true,
}

function agent(overrides: Partial<BudgetAgent> = {}): BudgetAgent {
  return {
    id: 'agent-1',
    name: 'Atlas',
    status: 'active',
    account_chain_id: 8453,
    // The CAP — 25 USDC a week. Read for the period word only; a fixture
    // that proves the cap is no longer the answer sets a low remaining.
    allowances: [
      { id: 'alw-1', agent_id: 'agent-1', token_address: USDC, token_symbol: 'USDC', allowance_amount: '25.00', reset_period_min: 10080 },
    ],
    receivedSubBudgets: [],
    ...overrides,
  }
}

function budgetRow(overrides: Partial<DashboardBudgetRemainingEntry> = {}): DashboardBudgetRemainingEntry {
  return {
    agent_id: 'agent-1',
    chain_id: 8453,
    delegation_hash: `0x${'1'.repeat(64)}`,
    token_address: USDC,
    token_symbol: 'USDC',
    token_decimals: 6,
    budget_atomic: '25000000',
    read_at: null,
    period_end: new Date(NOW_MS + 86_400_000).toISOString(),
    remaining_atomic: '20000000',
    remaining_from_chain: true,
    used_atomic: '5000000',
    sub_budget_spend: [],
    ...overrides,
  }
}

function merchantBudgetRow(
  overrides: Partial<Extract<MerchantBudget, Record<string, unknown>>> = {},
): MerchantBudget {
  return {
    agent_id: 'agent-1',
    agent_name: 'Atlas',
    chain_id: 8453,
    token_address: USDC,
    recipient_address: PAY_TO,
    delegation_hash: `0x${'2'.repeat(64)}`,
    budget_atomic: '25000000',
    period_seconds: 604_800,
    expires_at: String(NOW_MS / 1000 + 30 * 86_400),
    remaining_atomic: '20000000',
    remaining_is_from_chain: true,
    pin_status: 'current',
    ...overrides,
  }
}

// 10 USDC against a 25 USDC budget that has 20 USDC left — the default run
// answers 'can'. Each fixture below breaks exactly ONE thing.
function run(
  overrides: Partial<AgentsThatCanPayInput> = {},
): BudgetAgentAnswer[] {
  return agentsThatCanPay({
    // entry() is bridge-only (asset_transfer_methods null), so the OPEN
    // budget is the selected one by default.
    offer: entry({ price_atomic: '10000000' }),
    agents: [agent()],
    budgets: [budgetRow()],
    merchantBudgets: [],
    funding: [verifiedFunding],
    nowMs: NOW_MS,
    ...overrides,
  })
}

describe('agentsThatCanPay (#4004)', () => {
  // ── The known-nos: one fixture per reason, where ONLY that reason fails ────

  it('says no when the cap covers but what is LEFT does not — the case the old cap check got wrong', () => {
    const answers = run({ budgets: [budgetRow({ remaining_atomic: '1000000' })] })
    expect(answers[0]!.answer).toBe('cannot')
    // The period word comes from the budget's period (weekly via the cap's
    // reset_period_min) — the row names the agent and the period.
    expect(budgetAnswerLine(answers)).toBe('More than Atlas has left this week')
  })

  it('says no when the only budget is locked to ANOTHER recipient and there is no open one', () => {
    const answers = run({ budgets: [budgetRow({ recipient_address: OTHER_PAY_TO })] })
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('answers no when the locked budget is SPENT while the open budget has room — on an erc7710 offer the locked budget wins', () => {
    const answers = agentsThatCanPay({
      offer: entry({ price_atomic: '10000000', asset_transfer_methods: 'eip3009,erc7710' }),
      agents: [agent()],
      budgets: [
        budgetRow({ recipient_address: PAY_TO, remaining_atomic: '1000000' }),
        budgetRow({ delegation_hash: `0x${'3'.repeat(64)}`, remaining_atomic: '50000000' }),
      ],
      merchantBudgets: [],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('says no for a bridge-only offer when the agent holds only a locked budget', () => {
    // entry() carries no erc7710 — the bridge path uses only the open budget.
    const answers = run({ budgets: [budgetRow({ recipient_address: PAY_TO })] })
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('says no when the agent is paused', () => {
    const answers = run({ agents: [agent({ status: 'paused' })] })
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('says no when the agent\u2019s account is on another chain', () => {
    const answers = run({ agents: [agent({ account_chain_id: 84532 })] })
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('says no when no agent holds a budget in the offer\u2019s token', () => {
    const answers = run({
      budgets: [budgetRow({ token_symbol: 'EURe', token_address: `0x${'e'.repeat(40)}` })],
    })
    expect(answers[0]!.answer).toBe('cannot')
  })

  // ── The known-yeses ───────────────────────────────────────────────────────

  it('says an open budget with room can pay (bridge-only offer)', () => {
    const answers = run()
    expect(answers[0]!.answer).toBe('can')
    expect(budgetAnswerLine(answers)).toBe('Atlas can pay this')
  })

  it('says a locked budget with room can pay an erc7710 offer', () => {
    const answers = agentsThatCanPay({
      offer: entry({ price_atomic: '10000000', asset_transfer_methods: 'eip3009,erc7710' }),
      agents: [agent()],
      budgets: [budgetRow({ recipient_address: PAY_TO })],
      merchantBudgets: [],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
    expect(answers[0]!.answer).toBe('can')
  })

  it('reads a locked budget that only the merchant-budgets wire carries (by resolved token address)', () => {
    const answers = agentsThatCanPay({
      offer: entry({ price_atomic: '10000000', asset_transfer_methods: 'eip3009,erc7710' }),
      agents: [agent()],
      budgets: [],
      merchantBudgets: [merchantBudgetRow()],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
    expect(answers[0]!.answer).toBe('can')
  })

  // ── Unknown is silent, never "can't pay" (#2295) ──────────────────────────

  it('says unknown when the remaining read is null', () => {
    const answers = run({ budgets: [budgetRow({ remaining_atomic: null })] })
    expect(answers[0]!.answer).toBe('unknown')
  })

  it('says unknown when the budget-remaining wire reports the read did not come from the chain', () => {
    const answers = run({ budgets: [budgetRow({ remaining_from_chain: false, remaining_atomic: '20000000' })] })
    expect(answers[0]!.answer).toBe('unknown')
  })

  it('says unknown when the merchant-budgets wire reports remaining_is_from_chain false', () => {
    const answers = agentsThatCanPay({
      offer: entry({ price_atomic: '10000000', asset_transfer_methods: 'eip3009,erc7710' }),
      agents: [agent()],
      budgets: [],
      merchantBudgets: [merchantBudgetRow({ remaining_is_from_chain: false })],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
    expect(answers[0]!.answer).toBe('unknown')
  })

  it('says unknown for an agent that pays from a received sub-budget — a power the helper does not model', () => {
    const holder = agent({
      id: 'agent-2',
      name: 'Blinks',
      allowances: [],
      receivedSubBudgets: [{ parent_agent_id: 'parent-1', parent_agent_name: 'Parent', open: true }],
    })
    expect(run({ agents: [holder], budgets: [] })[0]!.answer).toBe('unknown')
    // Never as UNABLE either: a low remaining + an open sub-budget is unknown.
    expect(
      run({ agents: [holder], budgets: [budgetRow({ agent_id: 'agent-2', remaining_atomic: '1000000' })] })[0]!
        .answer,
    ).toBe('unknown')
  })

  // ── The #3802 future-dated re-key row ─────────────────────────────────────

  it('ignores a row whose start_date is in the future — the dormant half of a re-key is not spendable', () => {
    const answers = run({
      budgets: [
        budgetRow({
          start_date: new Date(NOW_MS + 3_600_000).toISOString(),
          remaining_atomic: '50000000',
        }),
      ],
    })
    // If the future-dated row were counted, this would answer 'can'.
    expect(answers[0]!.answer).toBe('cannot')
  })

  it('still answers from a future-dated row once its window opens', () => {
    const answers = run({
      nowMs: NOW_MS + 7_200_000,
      budgets: [
        budgetRow({
          start_date: new Date(NOW_MS + 3_600_000).toISOString(),
          remaining_atomic: '50000000',
        }),
      ],
    })
    expect(answers[0]!.answer).toBe('can')
  })

  // ── No price, no decimals — nobody's answer is known ──────────────────────

  it('says unknown for every agent when the offer has no price', () => {
    const answers = run({ offer: entry({ price_atomic: null }) })
    expect(answers[0]!.answer).toBe('unknown')
  })
})

describe('budgetAnswerLine (#4004)', () => {
  const answer = (
    agentName: string,
    answerName: BudgetAgentAnswer['answer'],
    periodPhrase: string | null = null,
    reason: BudgetAgentAnswer['reason'] = answerName === 'cannot' ? 'insufficient' : null,
  ): BudgetAgentAnswer => ({ agentId: agentName, agentName, answer: answerName, reason, periodPhrase })

  it('names the ONE agent that can pay', () => {
    expect(budgetAnswerLine([answer('Atlas', 'cannot'), answer('Blinks', 'can')])).toBe('Blinks can pay this')
  })

  it('names the first able agent and counts the rest', () => {
    expect(budgetAnswerLine([answer('Atlas', 'can'), answer('Blinks', 'can'), answer('Cato', 'can')])).toBe(
      'Atlas and 2 other agents can pay this',
    )
    expect(budgetAnswerLine([answer('Atlas', 'can'), answer('Blinks', 'can')])).toBe(
      'Atlas and 1 other agent can pay this',
    )
  })

  it('says no agent can pay when EVERY agent\u2019s answer is a known no — whatever the reasons', () => {
    expect(budgetAnswerLine([answer('Atlas', 'cannot'), answer('Blinks', 'cannot')])).toBe(
      'No agent can pay this yet',
    )
    // A wrong-chain no says nothing about anyone's balance, so the row never
    // names it as one — but once EVERY agent is a known no, the row says so.
    expect(budgetAnswerLine([answer('Atlas', 'cannot', null, 'wrong-chain')])).toBe('No agent can pay this yet')
    expect(
      budgetAnswerLine([answer('Atlas', 'cannot', 'today', 'insufficient'), answer('Blinks', 'cannot', null, 'wrong-chain')]),
    ).toBe('No agent can pay this yet')
  })

  it('names the one known no when the others are unknown — unknown is never a no', () => {
    expect(budgetAnswerLine([answer('Atlas', 'cannot', 'today'), answer('Blinks', 'unknown')])).toBe(
      'More than Atlas has left today',
    )
    // A no whose period is unknown still names the agent, just without a period.
    expect(budgetAnswerLine([answer('Atlas', 'cannot', null), answer('Blinks', 'unknown')])).toBe(
      'More than Atlas has left',
    )
  })

  it('never names a no that is not about the offer\u2019s token — a wrong-chain or paused agent beside an unknown renders nothing', () => {
    expect(budgetAnswerLine([answer('Atlas', 'cannot', null, 'wrong-chain'), answer('Blinks', 'unknown')])).toBeNull()
    expect(budgetAnswerLine([answer('Atlas', 'cannot', null, 'inactive'), answer('Blinks', 'unknown')])).toBeNull()
  })

  it('says nothing when nothing is known', () => {
    expect(budgetAnswerLine([answer('Atlas', 'unknown'), answer('Blinks', 'unknown')])).toBeNull()
    expect(budgetAnswerLine([])).toBeNull()
  })
})

// ── #4005: the selected-budget figures ride on the answer ───────────────────

describe('agentsThatCanPay selected figures (#4005)', () => {
  it('carries the open budget that pays, with its cap and period word', () => {
    const answers = run()
    expect(answers[0]!.selected).toEqual({
      recipientAddress: null,
      remainingAtomic: '20000000',
      budgetAtomic: '25000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      periodPhrase: 'this week',
    })
  })

  it('carries the LOCKED budget that pays an erc7710 offer', () => {
    const answers = agentsThatCanPay({
      offer: entry({ price_atomic: '10000000', asset_transfer_methods: 'eip3009,erc7710' }),
      agents: [agent()],
      budgets: [budgetRow({ recipient_address: PAY_TO })],
      merchantBudgets: [],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
    expect(answers[0]!.answer).toBe('can')
    expect(answers[0]!.selected!.recipientAddress).toBe(PAY_TO)
  })

  it('carries the figures on an insufficient no too — the panel names what is left', () => {
    const answers = run({ budgets: [budgetRow({ remaining_atomic: '1000000' })] })
    expect(answers[0]!.answer).toBe('cannot')
    expect(answers[0]!.selected!.remainingAtomic).toBe('1000000')
  })

  it('carries nothing when the answer is unknown or has no budget', () => {
    expect(run({ budgets: [budgetRow({ remaining_atomic: null })] })[0]!.selected).toBeUndefined()
    expect(run({ budgets: [] })[0]!.selected).toBeUndefined()
  })
})

// ── The "How to buy" panel's merchant-level answer (#4005) ──────────────────

describe('howToBuy (#4005)', () => {
  function runHowToBuy(overrides: {
    offers?: CatalogEntry[]
    agents?: BudgetAgent[]
    budgets?: DashboardBudgetRemainingEntry[]
    merchantBudgets?: MerchantBudget[]
  }) {
    return howToBuy({
      merchantName: 'Merchant Example',
      offers: overrides.offers ?? [entry({ price_atomic: '10000000' })],
      agents: overrides.agents ?? [agent()],
      budgets: overrides.budgets ?? [budgetRow()],
      merchantBudgets: overrides.merchantBudgets ?? [],
      funding: [verifiedFunding],
      nowMs: NOW_MS,
    })
  }

  it('is done, naming the agent and the budget that pays — an open budget can pay anyone', () => {
    const result = runHowToBuy({})
    expect(result).toEqual({
      kind: 'done',
      agentName: 'Atlas',
      partial: false,
      selected: expect.objectContaining({ recipientAddress: null, remainingAtomic: '20000000' }),
    })
  })

  it('is done with partial=true when the agent cannot pay EVERY offer', () => {
    // The second offer is on another chain — the agent cannot pay it.
    const result = runHowToBuy({ offers: [entry({ price_atomic: '10000000' }), entry({ id: 'cat-2', network: 'eip155:84532' })] })
    if (result.kind !== 'done') throw new Error(`expected done, got ${result.kind}`)
    expect(result.partial).toBe(true)
  })

  it('names the budget fix when the agent has no budget it can spend here', () => {
    const result = runHowToBuy({ budgets: [] })
    expect(result).toMatchObject({ kind: 'budget-fix', agentName: 'Atlas', agentId: 'agent-1', selected: null })
  })

  it('names the budget fix when the agent\\u2019s only budget is locked to ANOTHER recipient', () => {
    const result = runHowToBuy({ budgets: [budgetRow({ recipient_address: OTHER_PAY_TO })] })
    expect(result.kind).toBe('budget-fix')
    expect(result).toMatchObject({ agentName: 'Atlas', selected: null })
  })

  it('names the budget fix with the figures when the budget here is real but SHORT', () => {
    const result = runHowToBuy({ budgets: [budgetRow({ remaining_atomic: '1000000' })] })
    expect(result.kind).toBe('budget-fix')
    expect((result as { selected: { remainingAtomic: string } | null }).selected!.remainingAtomic).toBe('1000000')
  })

  it('says wrong-network when no agent can pay and every no is a chain no — no in-app fix exists', () => {
    const result = runHowToBuy({
      agents: [agent({ account_chain_id: 84532, allowances: [] })],
      budgets: [],
    })
    expect(result).toEqual({ kind: 'wrong-network', agentName: 'Atlas', agentChainId: 84532, offerChainIds: [8453] })
  })

  it('claims nothing when the answers are unknown', () => {
    expect(runHowToBuy({ budgets: [budgetRow({ remaining_atomic: null })] }).kind).toBe('uncertain')
    expect(runHowToBuy({ agents: [], budgets: [] }).kind).toBe('uncertain')
  })

  it('prefers a budget fix over a chain no when agents disagree, and nothing over both when unknowns exist', () => {
    // Blinks has no budget at all; Atlas is on the wrong chain. A budget is
    // the actionable fix, so it names Blinks.
    const disagreement = runHowToBuy({
      agents: [agent({ account_chain_id: 84532, allowances: [] }), agent({ id: 'agent-2', name: 'Blinks', account_chain_id: 8453, allowances: [] })],
      budgets: [],
    })
    expect(disagreement).toMatchObject({ kind: 'budget-fix', agentName: 'Blinks' })
    // An unknown anywhere beats both — the panel never claims what the data
    // cannot support.
    const withUnknown = runHowToBuy({
      agents: [
        agent({ account_chain_id: 84532, allowances: [] }),
        agent({
          id: 'agent-3',
          name: 'Holder',
          account_chain_id: 8453,
          allowances: [],
          receivedSubBudgets: [{ parent_agent_id: 'p', parent_agent_name: 'P', open: true }],
        }),
      ],
      budgets: [],
    })
    expect(withUnknown.kind).toBe('uncertain')
  })

  it('claims nothing when an unknown answer sits beside a budget-shaped no on ONE agent', () => {
    // The agent cannot afford the USDC offer (a real but short budget) and
    // cannot be MEASURED on the second offer — its asset symbol is not
    // registered, so no budget answer exists for it. Naming a budget fix
    // would claim a step the data cannot support: any unknown beats both,
    // including the budget fix.
    const result = runHowToBuy({
      offers: [
        entry({ price_atomic: '10000' }),
        entry({ id: 'cat-2', asset: 'NOPE', price_atomic: '10000' }),
      ],
      budgets: [budgetRow({ remaining_atomic: '1000' })],
    })
    expect(result.kind).toBe('uncertain')
  })
})

describe('agentInstruction', () => {
  it('uses the pay-via-tool phrasing for MCP merchants', () => {
    expect(agentInstruction(entry())).toBe(
      'Pay https://mcp.merchant.example/mcp via create_text for <what you want>',
    )
  })

  it('uses plain pay phrasing for HTTP x402 merchants', () => {
    expect(agentInstruction(entry({ protocol: 'http', tool_name: null }))).toBe(
      'Pay https://mcp.merchant.example/mcp and return the result',
    )
  })

  it('uses MPP phrasing for MPP merchants', () => {
    expect(agentInstruction(entry({ rail: 'mpp', protocol: 'http', tool_name: null }))).toContain(
      'machine-payment resource',
    )
  })
})

describe('networkToChainId', () => {
  it('resolves CAIP-2 and short-name network forms, undefined otherwise', () => {
    expect(networkToChainId('eip155:8453')).toBe(8453)
    expect(networkToChainId('eip155:84532')).toBe(84532)
    expect(networkToChainId('base')).toBe(8453)
    expect(networkToChainId('base-sepolia')).toBe(84532)
    expect(networkToChainId('gnosis')).toBe(100)
    expect(networkToChainId(null)).toBeUndefined()
    expect(networkToChainId('solana')).toBeUndefined()
  })
})

describe('categoryLabel', () => {
  it('keeps acronyms as acronyms and title-cases the rest', () => {
    expect(categoryLabel('api')).toBe('API')
    expect(categoryLabel('ai')).toBe('AI')
    expect(categoryLabel('infrastructure')).toBe('Infrastructure')
    expect(categoryLabel('media')).toBe('Media')
  })
})

describe('isTestnetChain / listsTestnet (decision 10)', () => {
  it('knows Base Sepolia from Base and Gnosis, and treats an unknown chain as NOT a testnet', () => {
    expect(isTestnetChain(84532)).toBe(true)
    expect(isTestnetChain(8453)).toBe(false)
    expect(isTestnetChain(100)).toBe(false)
    expect(isTestnetChain(999999)).toBe(false)
  })

  it('lists a testnet when any merchant serves one, in either network form', () => {
    expect(listsTestnet([{ networks: ['eip155:8453'] }])).toBe(false)
    expect(listsTestnet([{ networks: ['eip155:8453'] }, { networks: ['eip155:8453', 'eip155:84532'] }])).toBe(true)
    expect(listsTestnet([{ networks: ['base-sepolia'] }])).toBe(true)
    expect(listsTestnet([{ networks: ['solana'] }])).toBe(false)
    expect(listsTestnet([])).toBe(false)
  })
})

describe('needsUnpinnedBudget', () => {
  it('is true when the offer never advertised a transfer method', () => {
    expect(needsUnpinnedBudget(null)).toBe(true)
  })

  it('is true when erc7710 is absent from the advertised set', () => {
    expect(needsUnpinnedBudget('eip3009')).toBe(true)
  })

  it('is false once erc7710 is one of the advertised methods', () => {
    expect(needsUnpinnedBudget('eip3009,erc7710')).toBe(false)
    expect(needsUnpinnedBudget('erc7710')).toBe(false)
  })
})

describe('merchantInitials', () => {
  it('takes the first letter of the first and last word for a multi-word name', () => {
    expect(merchantInitials('Ampersend Demo API')).toBe('AA')
    expect(merchantInitials('Haven Demo Store')).toBe('HS')
  })

  it('takes the first two letters of a one-word name', () => {
    expect(merchantInitials('Minifetch')).toBe('MI')
  })
})

describe('freshness', () => {
  it('reports never verified when there is no timestamp', () => {
    expect(freshness(null)).toBe('not yet verified')
  })

  it('reports a recent verification in hours', () => {
    expect(freshness(new Date().toISOString())).toBe('verified just now')
  })
})

describe('needsUnpinnedBudget agrees with the agents\' funding_leg_expected hint (#3839)', () => {
  // One stored column, two readers: the marketplace badge and the discovery
  // hint an agent sees. They must never disagree about a merchant.
  const cases: Array<string | null> = [
    null,
    '',
    ' , ',
    'eip3009',
    'erc7710',
    'eip3009,erc7710',
    'eip3009, erc7710',
    // Exact match on both sides, like the settlement selector: not erc7710.
    'eip3009,ERC7710',
    'eip3009,permit2',
    'erc77100',
  ]
  for (const value of cases) {
    it(`agrees on ${JSON.stringify(value)}`, () => {
      expect(needsUnpinnedBudget(value)).toBe(catalogFundingLegExpected(value) !== false)
    })
  }
})
