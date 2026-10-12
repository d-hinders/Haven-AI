import { describe, expect, it } from 'vitest'
import {
  agentIsSetUp,
  ATTENTION_CAUGHT_UP_TITLE,
  ATTENTION_QUIET_LINE,
  attentionEmptyState,
  computeAttentionItems,
  firstRunSetupState,
  type DashboardBudgetRemaining,
  type DashboardOverview,
} from '../dashboard-attention'

/**
 * Rule fixtures for #3808. The rules read a narrow slice of the #3803/#3804
 * wire shapes (agents' status/budgets/refusal buckets, accounts' USDC block,
 * spend.failedIntents7d, budget-remaining entries) — each test builds exactly
 * that slice and casts; the full generated type is exercised end to end by
 * the backend's dashboard tests and the component tests.
 */

type AgentSlice = {
  id: string
  name: string
  status: 'active' | 'paused' | 'pending_approval' | 'revoked'
  accountId?: string | null
  accountName?: string | null
  setupStatus?: string
  budgets?: Array<Record<string, unknown>>
  receivedSubBudgets?: Array<{ open: boolean }>
  refusalBuckets?: { budget: number; scope: number; failed: number; haven: number }
}

type AccountSlice = {
  accountId: string
  isTestnet?: boolean
  usdcBalanceAtomic?: string | null
  usdcPace7dAtomic?: string
  funded?: boolean | null
  needs_backup_recommendation?: boolean
}

function makeOverview(
  agents: AgentSlice[],
  accounts: AccountSlice[],
  failedIntents7d = 0,
): DashboardOverview {
  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      accountId: agent.accountId ?? null,
      accountName: agent.accountName ?? null,
      accountChainId: null,
      allowances: [],
      ...(agent.setupStatus !== undefined ? { setupStatus: agent.setupStatus } : {}),
      budgets: (agent.budgets ?? []) as never,
      receivedSubBudgets: agent.receivedSubBudgets ?? [],
      stats: {
        d7: { refusals: agent.refusalBuckets ?? { budget: 0, scope: 0, failed: 0, haven: 0 } },
        d30: { refusals: { budget: 0, scope: 0, failed: 0, haven: 0 } },
      },
    })),
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      chainId: 8453,
      isTestnet: account.isTestnet ?? false,
      usdcBalanceAtomic: account.usdcBalanceAtomic ?? null,
      usdcDecimals: 6,
      funded: account.funded ?? null,
      needs_backup_recommendation: account.needs_backup_recommendation ?? false,
      usdcPace7dAtomic: account.usdcPace7dAtomic ?? '0',
    })),
    spend: { failedIntents7d },
  } as unknown as DashboardOverview
}

function budgetRemaining(
  entries: Array<{ agent_id: string; budget_atomic: string; used_atomic: string | null }>,
): DashboardBudgetRemaining {
  return {
    budgets: entries.map((entry) => ({
      ...entry,
      chain_id: 8453,
      delegation_hash: '0xhash',
      token_address: '0xtoken',
      token_symbol: 'USDC',
      token_decimals: 6,
      read_at: entry.used_atomic === null ? null : '2026-10-09T00:00:00Z',
      period_end: '2026-10-16T00:00:00Z',
      remaining_atomic: null,
      remaining_from_chain: true,
      sub_budget_spend: [],
    })),
  } as unknown as DashboardBudgetRemaining
}

const EMPTY_BUDGETS = null

describe('computeAttentionItems — needs setup (rule 1)', () => {
  it('gives a pending agent and an active agent without budgets exactly one item each', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          { id: 'a1', name: 'Scout', status: 'pending_approval', setupStatus: 'awaiting_connection' },
          { id: 'a2', name: 'Runner', status: 'active' },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    const needsSetup = items.filter((item) => item.kind === 'needs-setup')
    expect(needsSetup).toHaveLength(2)
    expect(needsSetup.map((item) => item.agentId)).toEqual(['a1', 'a2'])
    expect(needsSetup.every((item) => item.tone === 'brand')).toBe(true)
  })

  it('shows "Remove" for a pending agent whose setup expired or failed', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          { id: 'a1', name: 'Scout', status: 'pending_approval', setupStatus: 'expired' },
          { id: 'a2', name: 'Runner', status: 'pending_approval', setupStatus: 'failed' },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'needs-setup')).toHaveLength(2)
    expect(items.every((item) => item.actionLabel === 'Remove')).toBe(true)
  })

  it('gives an agent with an open received sub-budget no Needs-setup item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [],
            receivedSubBudgets: [{ open: true }],
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'needs-setup')).toHaveLength(0)
  })

  it('gives an active agent with a live budget no Needs-setup item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'needs-setup')).toHaveLength(0)
  })
})

describe('computeAttentionItems — low balance (rule 2)', () => {
  const twoAccounts = makeOverview(
    [
      {
        id: 'a1',
        name: 'Scout',
        status: 'active',
        accountId: 'acct-short',
        budgets: [{ budgetAtomic: '1' }],
      },
    ],
    [
      { accountId: 'acct-short', usdcBalanceAtomic: '1000000', usdcPace7dAtomic: '5000000' },
      { accountId: 'acct-fine', usdcBalanceAtomic: '10000000', usdcPace7dAtomic: '1000000' },
    ],
  )

  it('names only the account that is short on a two-account user', () => {
    const items = computeAttentionItems({
      overview: twoAccounts,
      budgetRemaining: EMPTY_BUDGETS,
      accountNames: { 'acct-short': 'Main', 'acct-fine': 'Ops' },
    })
    const low = items.filter((item) => item.kind === 'low-balance')
    expect(low).toHaveLength(1)
    expect(low[0].title).toContain('Main')
    expect(low[0].title).not.toContain('Ops')
    expect(low[0].accountId).toBe('acct-short')
    expect(low[0].tone).toBe('warning')
  })

  it('gives an account holding ETH but no USDC the zero-USDC warning when its agents have budgets', () => {
    // The account block carries USDC only — an ETH balance never reaches these
    // rules. USDC known-zero + agents with budgets = the firm warning.
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            accountId: 'acct-empty',
            budgets: [{ budgetAtomic: '1' }],
          },
        ],
        [{ accountId: 'acct-empty', usdcBalanceAtomic: '0', usdcPace7dAtomic: '0' }],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      accountNames: { 'acct-empty': 'Main' },
    })
    const zero = items.filter((item) => item.kind === 'zero-usdc')
    expect(zero).toHaveLength(1)
    expect(zero[0].title).toContain('Main')
    expect(zero[0].tone).toBe('warning')
  })

  it('gives an account whose USDC read is unknown no low-balance or zero item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            accountId: 'acct-unknown',
            budgets: [{ budgetAtomic: '1' }],
          },
        ],
        // usdcBalanceAtomic null — a failed read, never read as zero (#3295).
        [{ accountId: 'acct-unknown', usdcBalanceAtomic: null, usdcPace7dAtomic: '5000000' }],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'low-balance' || item.kind === 'zero-usdc'))
      .toHaveLength(0)
  })

  it('holds the low-balance and zero-USDC items back while the guide asks for funds', () => {
    const items = computeAttentionItems({
      overview: twoAccounts,
      budgetRemaining: EMPTY_BUDGETS,
      accountNames: { 'acct-short': 'Main', 'acct-fine': 'Ops' },
      holdBackLowBalance: true,
    })
    expect(items.filter((item) => item.kind === 'low-balance' || item.kind === 'zero-usdc'))
      .toHaveLength(0)
  })

  it('never flags a low balance when the account is not spending', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [],
        [{ accountId: 'acct-idle', usdcBalanceAtomic: '10', usdcPace7dAtomic: '0' }],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items).toHaveLength(0)
  })
})

describe('computeAttentionItems — budget reached (rule 3)', () => {
  it('gives a week of budget-bucket refusals a neutral item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 7, scope: 0, failed: 0, haven: 0 },
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    const reached = items.filter((item) => item.kind === 'budget-reached')
    expect(reached).toHaveLength(1)
    expect(reached[0].tone).toBe('neutral')
    expect(reached[0].badge).toBe('Budget reached')
  })

  it('gives scope refusals their own wording, still neutral', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 0, scope: 2, failed: 0, haven: 0 },
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    const scope = items.filter((item) => item.kind === 'budget-scope')
    expect(scope).toHaveLength(1)
    expect(scope[0].title).toMatch(/recipient its budget doesn't cover/)
    expect(scope[0].tone).toBe('neutral')
  })

  it('fires the ≥90%-of-period rule on a known read only', () => {
    const overview = makeOverview(
      [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
      [],
    )
    const items = computeAttentionItems({
      overview,
      budgetRemaining: budgetRemaining([
        { agent_id: 'a1', budget_atomic: '1000000', used_atomic: '950000' },
      ]),
    })
    expect(items.filter((item) => item.kind === 'budget-reached')).toHaveLength(1)

    // Unknown read (used_atomic null) never counts as reached (#3804).
    const unknown = computeAttentionItems({
      overview,
      budgetRemaining: budgetRemaining([
        { agent_id: 'a1', budget_atomic: '1000000', used_atomic: null },
      ]),
    })
    expect(unknown.filter((item) => item.kind === 'budget-reached')).toHaveLength(0)
  })

  it('never produces a budget item from relayer_budget refusals — Haven paused instead', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 0, scope: 0, failed: 0, haven: 4 },
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'budget-reached' || item.kind === 'budget-scope'))
      .toHaveLength(0)
    const paused = items.filter((item) => item.kind === 'haven-paused')
    expect(paused).toHaveLength(1)
    expect(paused[0].tone).toBe('neutral')
    // #3880: the reassurance leads, so a clamped line still carries it.
    expect(paused[0].subtitle?.startsWith('Your budgets are untouched')).toBe(true)
  })
})

describe('computeAttentionItems — payments failed (rule 4)', () => {
  it('gives one onchain_revert a danger item naming the agent', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 0, scope: 0, failed: 1, haven: 0 },
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    const failed = items.filter((item) => item.kind === 'payments-failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].tone).toBe('danger')
    expect(failed[0].title).toContain('Scout')
  })

  it('surfaces the user-level failed-intent count when no agent is named', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
        [],
        2,
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    const failed = items.filter((item) => item.kind === 'payments-failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].agentId).toBeUndefined()
  })

  it('does not double-report when a named failed agent already exists', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 0, scope: 0, failed: 1, haven: 0 },
          },
        ],
        [],
        3,
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'payments-failed')).toHaveLength(1)
  })
})

describe('computeAttentionItems — backup signer (rule 5)', () => {
  it('renders per account and never for a test-network account', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [],
        [
          { accountId: 'acct-1', needs_backup_recommendation: true, funded: true },
          { accountId: 'acct-2', needs_backup_recommendation: true, funded: true },
          { accountId: 'acct-test', isTestnet: true, needs_backup_recommendation: true, funded: true },
          { accountId: 'acct-unknown', needs_backup_recommendation: true, funded: null },
          { accountId: 'acct-unfunded', needs_backup_recommendation: true, funded: false },
        ],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      accountNames: { 'acct-1': 'Main', 'acct-2': 'Ops' },
    })
    const backup = items.filter((item) => item.kind === 'no-backup')
    expect(backup.map((item) => item.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(backup.every((item) => item.tone === 'warning')).toBe(true)
    expect(backup[0].title).toContain('Main')
    expect(backup[1].title).toContain('Ops')
  })

  it('stays hidden for an id in dismissedIds — the server-saved list (#3813)', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [],
        [{ accountId: 'acct-1', needs_backup_recommendation: true, funded: true }],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      dismissedIds: new Set(['no-backup:acct-1']),
    })
    expect(items.filter((item) => item.kind === 'no-backup')).toHaveLength(0)
  })

  it('a backup dismissal for one account does not hide another account\u2019s item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [],
        [
          { accountId: 'acct-1', needs_backup_recommendation: true, funded: true },
          { accountId: 'acct-2', needs_backup_recommendation: true, funded: true },
        ],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      // The dismissal belongs to the account it was made on: acct-2 still
      // raises its own item (and an account funded after the dismissal
      // elsewhere would too — its id is simply not in the set).
      dismissedIds: new Set(['no-backup:acct-1']),
    })
    expect(items.filter((item) => item.kind === 'no-backup').map((item) => item.accountId)).toEqual([
      'acct-2',
    ])
  })

  it('a needs-setup dismissal hides only that agent\u2019s item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          { id: 'a1', name: 'Scout', status: 'active', accountId: 'acct-1' },
          { id: 'a2', name: 'Runner', status: 'active', accountId: 'acct-1' },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      dismissedIds: new Set(['needs-setup:a1']),
    })
    expect(items.filter((item) => item.kind === 'needs-setup').map((item) => item.id)).toEqual([
      'needs-setup:a2',
    ])
  })
})

describe('computeAttentionItems — ordering', () => {
  it('emits the item classes in the issue order', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          { id: 'a1', name: 'Scout', status: 'pending_approval', setupStatus: 'awaiting_connection' },
          {
            id: 'a2',
            name: 'Runner',
            status: 'active',
            accountId: 'acct-1',
            budgets: [{ budgetAtomic: '1' }],
            refusalBuckets: { budget: 1, scope: 1, failed: 1, haven: 1 },
          },
        ],
        [
          { accountId: 'acct-1', usdcBalanceAtomic: '0', usdcPace7dAtomic: '0' },
          { accountId: 'acct-2', needs_backup_recommendation: true, funded: true },
        ],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.map((item) => item.kind)).toEqual([
      'needs-setup',
      'zero-usdc',
      'budget-reached',
      'budget-scope',
      'haven-paused',
      'payments-failed',
      'no-backup',
    ])
  })
})

// ── #3818: the first-run guide's facts, from the same overview the rules read ──
describe('firstRunSetupState (#3818)', () => {
  // #3818 review: the overview admits only active/paused/pending agents
  // (backend SQL), but the frontend rule must hold on its own — a revoked
  // agent that still carries a budget never completes step 2.
  it('a revoked agent with a budget is never set up', () => {
    const overview = makeOverview(
      [{ id: 'r1', name: 'Gone', status: 'revoked', budgets: [{ budgetAtomic: '1' }] }],
      [{ accountId: 'a1', funded: true }],
    )
    expect(agentIsSetUp(overview.agents![0] as never)).toBe(false)
    expect(firstRunSetupState(overview).hasSetUpAgent).toBe(false)
  })

  const BUDGET = [{ id: 'b1' }]

  describe('step 1 — USDC on an account, never another token, never a guessed zero', () => {
    it('any account funded completes it (owner decision: any USDC above zero)', () => {
      const overview = makeOverview([], [
        { accountId: 'a1', funded: false },
        { accountId: 'a2', funded: true },
      ])
      expect(firstRunSetupState(overview).usdcFunded).toBe(true)
    })

    it('false only when EVERY account is known to hold no USDC', () => {
      expect(firstRunSetupState(makeOverview([], [{ accountId: 'a1', funded: false }])).usdcFunded).toBe(false)
    })

    it('an unavailable read with nothing funded is unknown (null), not unfunded', () => {
      const overview = makeOverview([], [
        { accountId: 'a1', funded: false },
        { accountId: 'a2', funded: null },
      ])
      expect(firstRunSetupState(overview).usdcFunded).toBeNull()
    })
  })

  describe('step 2 — an agent that can actually pay', () => {
    it('a pending_approval agent does not complete it, and is named for "Finish setup"', () => {
      const state = firstRunSetupState(
        makeOverview([{ id: 'p1', name: 'Pending', status: 'pending_approval' }], []),
      )
      expect(state.hasSetUpAgent).toBe(false)
      expect(state.pendingAgent).toEqual({ id: 'p1', name: 'Pending', moreCount: 0, awaiting: 'approval' })
    })

    it('an active agent without a usable budget does not complete it', () => {
      const state = firstRunSetupState(makeOverview([{ id: 'x', name: 'X', status: 'active' }], []))
      expect(state.hasSetUpAgent).toBe(false)
      expect(state.pendingAgent?.id).toBe('x')
    })

    it('an active agent with a budget completes it; so does a paused one (set up, payments held)', () => {
      expect(
        firstRunSetupState(makeOverview([{ id: 'a', name: 'A', status: 'active', budgets: BUDGET }], [])).hasSetUpAgent,
      ).toBe(true)
      expect(
        firstRunSetupState(makeOverview([{ id: 'p', name: 'P', status: 'paused', budgets: BUDGET }], [])).hasSetUpAgent,
      ).toBe(true)
    })

    it('a zero-cap budget does not complete it — the agents section reads it "No budget" (#3897)', () => {
      expect(
        firstRunSetupState(
          makeOverview([{ id: 'z', name: 'Z', status: 'active', budgets: [{ id: 'b0', budgetAtomic: '0' }] }], []),
        ).hasSetUpAgent,
      ).toBe(false)
    })

    it('an open received sub-budget counts as a usable budget', () => {
      const overview = makeOverview(
        [{ id: 's', name: 'S', status: 'active', receivedSubBudgets: [{ open: true }] }],
        [],
      )
      expect(firstRunSetupState(overview).hasSetUpAgent).toBe(true)
    })

    it('names the NEWEST waiting agent by GET /agents created_at, with "and N more"', () => {
      const overview = makeOverview(
        [
          { id: 'old', name: 'Old', status: 'pending_approval' },
          { id: 'new', name: 'New', status: 'pending_approval' },
          { id: 'mid', name: 'Mid', status: 'active' },
        ],
        [],
      )
      const state = firstRunSetupState(overview, {
        old: '2026-10-01T00:00:00Z',
        new: '2026-10-09T00:00:00Z',
        mid: '2026-10-05T00:00:00Z',
      })
      expect(state.pendingAgent).toEqual({ id: 'new', name: 'New', moreCount: 2, awaiting: 'approval' })
    })

    it('an agent missing from GET /agents is newer than that read, so it is the one named', () => {
      const overview = makeOverview(
        [
          { id: 'known', name: 'Known', status: 'pending_approval' },
          { id: 'fresh', name: 'Fresh', status: 'pending_approval' },
        ],
        [],
      )
      expect(firstRunSetupState(overview, { known: '2026-10-09T00:00:00Z' }).pendingAgent?.id).toBe('fresh')
    })

    it('an active agent without a budget is awaiting a budget, not an approval', () => {
      const state = firstRunSetupState(makeOverview([{ id: 'x', name: 'X', status: 'active' }], []))
      expect(state.pendingAgent?.awaiting).toBe('budget')
    })

    it('a pending agent whose setup expired or failed is not offered "Finish setup" (its row says Remove)', () => {
      const state = firstRunSetupState(
        makeOverview([{ id: 'f', name: 'F', status: 'pending_approval', setupStatus: 'expired' }], []),
      )
      expect(state.pendingAgent).toBeNull()
      expect(state.hasSetUpAgent).toBe(false)
    })
  })

  it('agentIsSetUp is the complement of the "Needs setup" rule for the agents that rule covers', () => {
    const agents = [
      { id: 'p', name: 'P', status: 'pending_approval' as const },
      { id: 'n', name: 'N', status: 'active' as const },
      { id: 'b', name: 'B', status: 'active' as const, budgets: BUDGET },
    ]
    const overview = makeOverview(agents, [])
    const needsSetup = new Set(
      computeAttentionItems({ overview, budgetRemaining: null })
        .filter((item) => item.kind === 'needs-setup')
        .map((item) => item.agentId),
    )
    for (const agent of overview.agents) {
      expect(agentIsSetUp(agent), agent.id).toBe(!needsSetup.has(agent.id))
    }
  })
})

describe('attentionEmptyState (#3902) — the achievement only on measured facts', () => {
  // One funded account, one budgeted agent at 10% used: every fact measured and holding.
  const scout = { id: 'a1', name: 'Scout', status: 'active' as const, accountId: 'acct-1', budgets: [{ budgetAtomic: '10000000' }] }
  const roomy = budgetRemaining([{ agent_id: 'a1', budget_atomic: '10000000', used_atomic: '1000000' }])
  // 100 USDC at 10 USDC a week: 70 days — well over a month.
  const month = { accountId: 'acct-1', usdcBalanceAtomic: '100000000', usdcPace7dAtomic: '10000000', funded: true }
  const state = (overview: DashboardOverview, reads: DashboardBudgetRemaining | null, loading = false) =>
    attentionEmptyState({ overview, budgetRemaining: reads, budgetRemainingLoading: loading })

  it('is the achievement when the runway and the budget room are both measured and holding', () => {
    const result = state(makeOverview([scout], [month]), roomy)
    expect(result).toEqual({
      kind: 'caught-up',
      title: ATTENTION_CAUGHT_UP_TITLE,
      body: 'Your balance lasts well over a month at the current pace, and your agents have room in their budgets.',
    })
  })

  it('says "no agent spending this week" at a zero pace, never quoting a runway', () => {
    const result = state(makeOverview([scout], [{ ...month, usdcPace7dAtomic: '0' }]), roomy)
    expect(result.kind).toBe('caught-up')
    expect(result.kind === 'caught-up' && result.body).toBe(
      'No agent spending this week, and your agents have room in their budgets.',
    )
  })

  it('holds back both states while the budget reads load', () => {
    expect(state(makeOverview([scout], [month]), roomy, true)).toEqual({ kind: 'pending' })
    expect(state(makeOverview([scout], [month]), null, true)).toEqual({ kind: 'pending' })
  })

  it('is the neutral line for an unknown USDC balance', () => {
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: null }]), roomy)).toEqual({
      kind: 'quiet',
      body: ATTENTION_QUIET_LINE,
    })
  })

  it('is the neutral line for zero USDC, with or without budgeted agents', () => {
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: '0' }]), roomy).kind).toBe('quiet')
    expect(state(makeOverview([], [{ ...month, usdcBalanceAtomic: '0' }]), null).kind).toBe('quiet')
    // No spend this week and nothing to spend: never "no agent spending, all good".
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: '0', usdcPace7dAtomic: '0' }]), roomy).kind).toBe('quiet')
  })

  it('is the neutral line with no agents, or no budgeted agent', () => {
    expect(state(makeOverview([], [month]), roomy).kind).toBe('quiet')
    expect(state(makeOverview([{ ...scout, status: 'paused', budgets: [] }], [month]), roomy).kind).toBe('quiet')
  })

  it('is the neutral line for unknown budget reads — a failed read, or an unknown used amount', () => {
    expect(state(makeOverview([scout], [month]), null).kind).toBe('quiet')
    const unknown = budgetRemaining([{ agent_id: 'a1', budget_atomic: '10000000', used_atomic: null }])
    expect(state(makeOverview([scout], [month]), unknown).kind).toBe('quiet')
  })

  it('is the neutral line when ANY of an agent\'s budget reads is unknown, even beside a known one', () => {
    const mixed = budgetRemaining([
      { agent_id: 'a1', budget_atomic: '10000000', used_atomic: '1000000' },
      { agent_id: 'a1', budget_atomic: '10000000', used_atomic: null },
    ])
    expect(state(makeOverview([scout], [month]), mixed).kind).toBe('quiet')
  })

  it('treats a malformed used amount as unknown, never as room (#3295)', () => {
    const malformed = budgetRemaining([
      { agent_id: 'a1', budget_atomic: '10000000', used_atomic: '1000000' },
      { agent_id: 'a1', budget_atomic: '10000000', used_atomic: 'not-a-number' },
    ])
    expect(state(makeOverview([scout], [month]), malformed).kind).toBe('quiet')
  })

  it('is the neutral line after a scope refusal this week', () => {
    const refused = { ...scout, refusalBuckets: { budget: 0, scope: 1, failed: 0, haven: 0 } }
    expect(state(makeOverview([refused], [month]), roomy).kind).toBe('quiet')
  })

  it('is the neutral line at 90% used, or after a budget stop this week', () => {
    const nearly = budgetRemaining([{ agent_id: 'a1', budget_atomic: '10000000', used_atomic: '9000000' }])
    expect(state(makeOverview([scout], [month]), nearly).kind).toBe('quiet')
    const stopped = { ...scout, refusalBuckets: { budget: 1, scope: 0, failed: 0, haven: 0 } }
    expect(state(makeOverview([stopped], [month]), roomy).kind).toBe('quiet')
  })

  it('is the neutral line when the runway is a month or less — under the boundary and exactly on it', () => {
    // 3 weeks of balance: no low-balance item (over 7 days), but not "well over a month".
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: '30000000' }]), roomy).kind).toBe('quiet')
    // balance × 7 = pace × 30 exactly: 30 days is not OVER a month.
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: '30000000', usdcPace7dAtomic: '7000000' }]), roomy).kind).toBe('quiet')
    // One unit more crosses it.
    expect(state(makeOverview([scout], [{ ...month, usdcBalanceAtomic: '30000001', usdcPace7dAtomic: '7000000' }]), roomy).kind).toBe('caught-up')
  })

  it('checks the runway per account — a rich account cannot cover a short one', () => {
    const rich = { accountId: 'acct-1', usdcBalanceAtomic: '1000000000', usdcPace7dAtomic: '0', funded: true }
    const short = { accountId: 'acct-2', usdcBalanceAtomic: '20000000', usdcPace7dAtomic: '10000000', funded: true }
    // Summed: 1020 USDC at 10 a week is years. Per account: acct-2 has 14 days.
    expect(state(makeOverview([scout], [rich, short]), roomy).kind).toBe('quiet')
  })
})
