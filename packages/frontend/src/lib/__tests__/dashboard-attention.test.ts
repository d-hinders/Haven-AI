import { describe, expect, it } from 'vitest'
import {
  computeAttentionItems,
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
  status: 'active' | 'paused' | 'pending_approval'
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

  it('stays hidden while the legacy global dismissal is set', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [],
        [{ accountId: 'acct-1', needs_backup_recommendation: true, funded: true }],
      ),
      budgetRemaining: EMPTY_BUDGETS,
      backupDismissed: true,
    })
    expect(items.filter((item) => item.kind === 'no-backup')).toHaveLength(0)
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
