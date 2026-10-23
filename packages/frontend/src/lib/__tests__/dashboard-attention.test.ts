import { describe, expect, it } from 'vitest'
import {
  agentIsSetUp,
  ATTENTION_CAUGHT_UP_TITLE,
  ATTENTION_QUIET_LINE,
  attentionEmptyState,
  computeAttentionItems,
  DISMISSIBLE_ATTENTION_KINDS,
  firstRunSetupState,
  PAYMENTS_FAILED_DANGER_COUNT,
  type AttentionAcknowledgement,
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
  receivedSubBudgets?: Array<{ open: boolean; parentAgentName?: string }>
  refusalBuckets?: {
    budget: number
    scope: number
    failed: number
    haven: number
    lastBudgetAt?: string
    lastScopeAt?: string
    lastFailedAt?: string
    lastHavenAt?: string
  }
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
  lastFailedIntentAt?: string,
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
    spend: { failedIntents7d, ...(lastFailedIntentAt !== undefined ? { lastFailedIntentAt } : {}) },
  } as unknown as DashboardOverview
}

function budgetRemaining(
  entries: Array<{ agent_id: string; budget_atomic: string; used_atomic: string | null; period_end?: string }>,
): DashboardBudgetRemaining {
  return {
    budgets: entries.map((entry) => ({
      period_end: '2026-10-16T00:00:00Z',
      ...entry,
      chain_id: 8453,
      delegation_hash: '0xhash',
      token_address: '0xtoken',
      token_symbol: 'USDC',
      token_decimals: 6,
      read_at: entry.used_atomic === null ? null : '2026-10-09T00:00:00Z',
      remaining_atomic: null,
      remaining_from_chain: true,
      sub_budget_spend: [],
    })),
  } as unknown as DashboardBudgetRemaining
}

const EMPTY_BUDGETS = null

/** A server-saved acknowledgement map, keyed by rule-item id (#4324). */
function acks(entries: Record<string, string | { at: string; periodEnd: string }>): Map<string, AttentionAcknowledgement> {
  return new Map(
    Object.entries(entries).map(([id, value]) => [
      id,
      typeof value === 'string'
        ? { acknowledgedAt: value, acknowledgedPeriodEnd: null }
        : { acknowledgedAt: value.at, acknowledgedPeriodEnd: value.periodEnd },
    ]),
  )
}

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
            receivedSubBudgets: [{ parentAgentName: 'Agent naming', open: true }],
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'needs-setup')).toHaveLength(0)
  })

  // #3923 P3: the backend computes `open` with the unexpired rule, so an
  // expired received grant arrives `open: false` and is not a usable budget.
  it('gives an agent whose only budget is an expired received sub-budget (open: false) a Needs-setup item', () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [
          {
            id: 'a1',
            name: 'Scout',
            status: 'active',
            budgets: [],
            receivedSubBudgets: [{ parentAgentName: 'Agent naming', open: false }],
          },
        ],
        [],
      ),
      budgetRemaining: EMPTY_BUDGETS,
    })
    expect(items.filter((item) => item.kind === 'needs-setup')).toHaveLength(1)
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
    expect(zero).toEqual([
      {
        id: 'zero-usdc:acct-empty',
        kind: 'zero-usdc',
        tone: 'warning',
        // #4324: "No USDC", so it is not the same word as low balance.
        badge: 'No USDC',
        title: 'Main is out of USDC',
        subtitle: 'Its agents have budgets to spend, but no USDC left to spend.',
        actionLabel: 'Add funds',
        accountId: 'acct-empty',
      },
    ])
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
    expect(reached).toEqual([
      {
        id: 'budget-reached:a1',
        kind: 'budget-reached',
        tone: 'neutral',
        badge: 'Budget reached',
        title: 'Scout reached its budget',
        subtitle: 'Its budget stopped a payment in the last 7 days.',
        actionLabel: 'Review',
        // #4324: Review opens the agent's refused attempts (#4323).
        href: '/agents/a1?tab=activity&status=refused',
        agentId: 'a1',
      },
    ])
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
    expect(scope).toEqual([
      {
        id: 'budget-scope:a1',
        kind: 'budget-scope',
        tone: 'neutral',
        // #4324: its own badge — not the same word as a budget cap.
        badge: 'Outside its rules',
        title: "Scout tried to pay a recipient its budget doesn't cover",
        subtitle: 'The payment was refused — the recipient is outside its rules.',
        actionLabel: 'Review',
        href: '/agents/a1?tab=activity&status=refused',
        agentId: 'a1',
      },
    ])
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
    // #4324: its own kind, carrying the firing budget's period end.
    expect(items.filter((item) => item.kind === 'budget-usage')).toEqual([
      {
        id: 'budget-usage:a1',
        kind: 'budget-usage',
        tone: 'neutral',
        badge: 'Budget reached',
        title: 'Scout has used 90% of its budget',
        subtitle: 'Its current budget period is nearly spent.',
        actionLabel: 'Review',
        href: '/agents/a1',
        agentId: 'a1',
        periodEnd: '2026-10-16T00:00:00Z',
      },
    ])
    expect(items.filter((item) => item.kind === 'budget-reached')).toHaveLength(0)

    // Unknown read (used_atomic null) never counts as reached (#3804).
    const unknown = computeAttentionItems({
      overview,
      budgetRemaining: budgetRemaining([
        { agent_id: 'a1', budget_atomic: '1000000', used_atomic: null },
      ]),
    })
    expect(unknown.filter((item) => item.kind === 'budget-usage')).toHaveLength(0)
  })

  it('#4324: 89.99% does not fire the 90% item; exactly 90% does', () => {
    const overview = makeOverview(
      [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
      [],
    )
    const at = (used: string) =>
      computeAttentionItems({
        overview,
        budgetRemaining: budgetRemaining([{ agent_id: 'a1', budget_atomic: '1000000', used_atomic: used }]),
      }).filter((item) => item.kind === 'budget-usage')
    expect(at('899999')).toHaveLength(0)
    expect(at('900000')).toHaveLength(1)
  })

  it("#4324: the 90% item names the budget with the highest share spent, and carries that budget's period end", () => {
    const items = computeAttentionItems({
      overview: makeOverview(
        [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
        [],
      ),
      budgetRemaining: budgetRemaining([
        { agent_id: 'a1', budget_atomic: '1000000', used_atomic: '910000', period_end: '2026-10-24T00:00:00Z' },
        { agent_id: 'a1', budget_atomic: '1000000', used_atomic: '990000', period_end: '2026-11-01T00:00:00Z' },
      ]),
    })
    expect(items.find((item) => item.kind === 'budget-usage')?.periodEnd).toBe('2026-11-01T00:00:00Z')
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
    // #4324: one failure reads calm — neutral, and says no money moved.
    expect(failed).toEqual([
      {
        id: 'payments-failed:a1',
        kind: 'payments-failed',
        tone: 'neutral',
        badge: 'Failed',
        title: 'Scout had a failed payment',
        subtitle: 'A payment was refused by the network. No money moved.',
        actionLabel: 'Review',
        href: '/agents/a1?tab=activity&status=refused',
        agentId: 'a1',
      },
    ])
  })

  it('#4324: an agent with 3 failures in 7 days is danger; 2 stays neutral', () => {
    expect(PAYMENTS_FAILED_DANGER_COUNT).toBe(3)
    const failedItem = (failed: number) =>
      computeAttentionItems({
        overview: makeOverview(
          [
            {
              id: 'a1',
              name: 'Scout',
              status: 'active',
              budgets: [{ budgetAtomic: '1' }],
              refusalBuckets: { budget: 0, scope: 0, failed, haven: 0 },
            },
          ],
          [],
        ),
        budgetRemaining: EMPTY_BUDGETS,
      }).find((item) => item.kind === 'payments-failed')
    expect(failedItem(2)).toMatchObject({
      tone: 'neutral',
      subtitle: 'A payment was refused by the network. No money moved.',
    })
    expect(failedItem(3)).toEqual({
      id: 'payments-failed:a1',
      kind: 'payments-failed',
      tone: 'danger',
      badge: 'Failed',
      title: 'Scout had 3 failed payments',
      subtitle: 'Payments keep failing — check the agent.',
      actionLabel: 'Review',
      href: '/agents/a1?tab=activity&status=refused',
      agentId: 'a1',
    })
  })

  it('#4324: the unattributed item is neutral below 3 failed intents and danger at 3, never claiming no money moved', () => {
    const unattributed = (count: number) =>
      computeAttentionItems({
        overview: makeOverview(
          [{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }],
          [],
          count,
        ),
        budgetRemaining: EMPTY_BUDGETS,
      }).find((item) => item.kind === 'payments-failed')
    expect(unattributed(2)).toEqual({
      id: 'payments-failed:unattributed',
      kind: 'payments-failed',
      tone: 'neutral',
      badge: 'Failed',
      title: 'A payment failed',
      subtitle: 'A payment did not go through in the last 7 days.',
      actionLabel: 'View transactions',
      href: '/transactions',
    })
    expect(unattributed(3)).toEqual({
      id: 'payments-failed:unattributed',
      kind: 'payments-failed',
      tone: 'danger',
      badge: 'Failed',
      title: '3 payments failed',
      subtitle: 'Payments keep failing — check your agents.',
      actionLabel: 'View transactions',
      href: '/transactions',
    })
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

  it('stays hidden for an id in the server-saved dismissals (#3813) — and in the session-only set', () => {
    const overview = makeOverview(
      [],
      [{ accountId: 'acct-1', needs_backup_recommendation: true, funded: true }],
    )
    const saved = computeAttentionItems({
      overview,
      budgetRemaining: EMPTY_BUDGETS,
      acknowledgements: acks({ 'no-backup:acct-1': '2026-10-09T00:00:00Z' }),
    })
    expect(saved.filter((item) => item.kind === 'no-backup')).toHaveLength(0)
    const session = computeAttentionItems({
      overview,
      budgetRemaining: EMPTY_BUDGETS,
      dismissedIds: new Set(['no-backup:acct-1']),
    })
    expect(session.filter((item) => item.kind === 'no-backup')).toHaveLength(0)
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
      // elsewhere would too — its id is simply not in the map).
      acknowledgements: acks({ 'no-backup:acct-1': '2026-10-09T00:00:00Z' }),
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
      acknowledgements: acks({ 'needs-setup:a1': '2026-10-09T00:00:00Z' }),
    })
    expect(items.filter((item) => item.kind === 'needs-setup').map((item) => item.id)).toEqual([
      'needs-setup:a2',
    ])
  })
})

// ── #4324: acknowledge until something new ─────────────────────────────────
describe('computeAttentionItems — acknowledgements (#4324)', () => {
  const ACK = '2026-10-20T12:00:00.000Z'
  const BEFORE = '2026-10-20T11:00:00.000Z'
  const AFTER = '2026-10-20T13:00:00.000Z'

  const agentWith = (refusalBuckets: AgentSlice['refusalBuckets']): AgentSlice => ({
    id: 'a1',
    name: 'Scout',
    status: 'active',
    budgets: [{ budgetAtomic: '1' }],
    refusalBuckets,
  })
  const visibleIds = (overview: DashboardOverview, acknowledgements: Map<string, AttentionAcknowledgement>, reads: DashboardBudgetRemaining | null = EMPTY_BUDGETS) =>
    computeAttentionItems({ overview, budgetRemaining: reads, acknowledgements }).map((item) => item.id)

  it('every event-driven kind is dismissible; low balance and zero USDC are not', () => {
    expect([...DISMISSIBLE_ATTENTION_KINDS].sort()).toEqual(
      ['budget-reached', 'budget-scope', 'budget-usage', 'haven-paused', 'needs-setup', 'no-backup', 'payments-failed'].sort(),
    )
    expect(DISMISSIBLE_ATTENTION_KINDS.has('low-balance')).toBe(false)
    expect(DISMISSIBLE_ATTENTION_KINDS.has('zero-usdc')).toBe(false)
  })

  const CASES = [
    { id: 'budget-reached:a1', bucket: { budget: 2, scope: 0, failed: 0, haven: 0 }, field: 'lastBudgetAt' },
    { id: 'budget-scope:a1', bucket: { budget: 0, scope: 1, failed: 0, haven: 0 }, field: 'lastScopeAt' },
    { id: 'payments-failed:a1', bucket: { budget: 0, scope: 0, failed: 1, haven: 0 }, field: 'lastFailedAt' },
    { id: 'haven-paused', bucket: { budget: 0, scope: 0, failed: 0, haven: 1 }, field: 'lastHavenAt' },
  ] as const

  for (const { id, bucket, field } of CASES) {
    it(`${id}: an older or equal event keeps it hidden; a newer one brings it back`, () => {
      const at = (when: string) => makeOverview([agentWith({ ...bucket, [field]: when })], [])
      const ack = acks({ [id]: ACK })
      expect(visibleIds(at(BEFORE), ack)).not.toContain(id)
      expect(visibleIds(at(ACK), ack)).not.toContain(id)
      expect(visibleIds(at(AFTER), ack)).toContain(id)
      // Without an acknowledgement it shows as today.
      expect(visibleIds(at(BEFORE), acks({}))).toContain(id)
    })

    it(`${id}: a response without ${field} never hides the item (#3295)`, () => {
      const overview = makeOverview([agentWith(bucket)], [])
      expect(visibleIds(overview, acks({ [id]: ACK }))).toContain(id)
    })
  }

  it('the unattributed payments-failed item re-arms on lastFailedIntentAt', () => {
    const overview = (when?: string) =>
      makeOverview([{ id: 'a1', name: 'Scout', status: 'active', budgets: [{ budgetAtomic: '1' }] }], [], 1, when)
    const ack = acks({ 'payments-failed:unattributed': ACK })
    expect(visibleIds(overview(BEFORE), ack)).not.toContain('payments-failed:unattributed')
    expect(visibleIds(overview(AFTER), ack)).toContain('payments-failed:unattributed')
    expect(visibleIds(overview(undefined), ack)).toContain('payments-failed:unattributed')
  })

  it('an acknowledgement for one agent does not hide another agent\'s item of the same kind', () => {
    const overview = makeOverview(
      [
        { ...agentWith({ budget: 1, scope: 0, failed: 0, haven: 0, lastBudgetAt: BEFORE }) },
        { ...agentWith({ budget: 1, scope: 0, failed: 0, haven: 0, lastBudgetAt: BEFORE }), id: 'a2', name: 'Runner' },
      ],
      [],
    )
    expect(visibleIds(overview, acks({ 'budget-reached:a1': ACK }))).toEqual(['budget-reached:a2'])
  })

  describe('the 90%-used item', () => {
    const scout = { id: 'a1', name: 'Scout', status: 'active' as const, budgets: [{ budgetAtomic: '1' }] }
    const nearlySpent = (periodEnd: string) =>
      budgetRemaining([{ agent_id: 'a1', budget_atomic: '1000000', used_atomic: '950000', period_end: periodEnd }])

    it('stays hidden in the acknowledged period and returns in the next', () => {
      const ack = acks({ 'budget-usage:a1': { at: ACK, periodEnd: '2026-10-21T00:00:00Z' } })
      const overview = makeOverview([scout], [])
      expect(visibleIds(overview, ack, nearlySpent('2026-10-21T00:00:00Z'))).not.toContain('budget-usage:a1')
      expect(visibleIds(overview, ack, nearlySpent('2026-10-22T00:00:00Z'))).toContain('budget-usage:a1')
    })

    it('an acknowledgement without a stored period end never hides it', () => {
      const ack = acks({ 'budget-usage:a1': ACK })
      expect(visibleIds(makeOverview([scout], []), ack, nearlySpent('2026-10-21T00:00:00Z'))).toContain('budget-usage:a1')
    })

    it('is independent of the refusal item: hidden while the refusal item shows, shown once that is acknowledged', () => {
      const overview = makeOverview([{ ...scout, refusalBuckets: { budget: 1, scope: 0, failed: 0, haven: 0, lastBudgetAt: BEFORE } }], [])
      const reads = nearlySpent('2026-10-21T00:00:00Z')
      expect(visibleIds(overview, acks({}), reads)).toEqual(['budget-reached:a1'])
      expect(visibleIds(overview, acks({ 'budget-reached:a1': ACK }), reads)).toEqual(['budget-usage:a1'])
      // Acknowledging the 90% item does not hide a newer refusal.
      const newer = makeOverview([{ ...scout, refusalBuckets: { budget: 1, scope: 0, failed: 0, haven: 0, lastBudgetAt: AFTER } }], [])
      expect(
        visibleIds(newer, acks({ 'budget-reached:a1': ACK, 'budget-usage:a1': { at: ACK, periodEnd: '2026-10-21T00:00:00Z' } }), reads),
      ).toEqual(['budget-reached:a1'])
    })
  })

  describe('haven-paused', () => {
    it('Review opens the refused attempts of the agent with the latest sponsorship refusal', () => {
      const overview = makeOverview(
        [
          agentWith({ budget: 0, scope: 0, failed: 0, haven: 1, lastHavenAt: BEFORE }),
          { ...agentWith({ budget: 0, scope: 0, failed: 0, haven: 2, lastHavenAt: AFTER }), id: 'a2', name: 'Runner' },
        ],
        [],
      )
      const paused = computeAttentionItems({ overview, budgetRemaining: EMPTY_BUDGETS }).find((item) => item.kind === 'haven-paused')
      expect(paused).toEqual({
        id: 'haven-paused',
        kind: 'haven-paused',
        tone: 'neutral',
        title: 'Haven paused sponsored payments',
        subtitle: "Your budgets are untouched. Haven's own cap stopped a payment.",
        actionLabel: 'Review',
        href: '/agents/a2?tab=activity&status=refused',
      })
    })

    it('shows no action when a contributing agent\'s time is unknown, and still is dismissible', () => {
      const overview = makeOverview(
        [
          agentWith({ budget: 0, scope: 0, failed: 0, haven: 1, lastHavenAt: AFTER }),
          { ...agentWith({ budget: 0, scope: 0, failed: 0, haven: 1 }), id: 'a2', name: 'Runner' },
        ],
        [],
      )
      const paused = computeAttentionItems({ overview, budgetRemaining: EMPTY_BUDGETS }).find((item) => item.kind === 'haven-paused')
      expect(paused?.actionLabel).toBeUndefined()
      expect(paused?.href).toBeUndefined()
      expect(DISMISSIBLE_ATTENTION_KINDS.has('haven-paused')).toBe(true)
      // Unknown latest time: an acknowledgement never hides it.
      expect(visibleIds(overview, acks({ 'haven-paused': '2099-01-01T00:00:00Z' }))).toContain('haven-paused')
    })
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
        [{ id: 's', name: 'S', status: 'active', receivedSubBudgets: [{ parentAgentName: 'Agent naming', open: true }] }],
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
  const state = (
    overview: DashboardOverview,
    reads: DashboardBudgetRemaining | null,
    loading = false,
    acknowledgements?: Map<string, AttentionAcknowledgement>,
  ) => attentionEmptyState({ overview, budgetRemaining: reads, budgetRemainingLoading: loading, acknowledgements })

  it('#4324: is the achievement after every budget and scope stop is acknowledged, with no newer one', () => {
    const stopped = {
      ...scout,
      refusalBuckets: {
        budget: 1,
        scope: 1,
        failed: 0,
        haven: 0,
        lastBudgetAt: '2026-10-20T10:00:00Z',
        lastScopeAt: '2026-10-20T10:30:00Z',
      },
    }
    const both = acks({ 'budget-reached:a1': '2026-10-20T11:00:00Z', 'budget-scope:a1': '2026-10-20T11:00:00Z' })
    expect(state(makeOverview([stopped], [month]), roomy, false, both)).toEqual({
      kind: 'caught-up',
      title: ATTENTION_CAUGHT_UP_TITLE,
    })
    // One stop still unacknowledged: the neutral line.
    expect(state(makeOverview([stopped], [month]), roomy, false, acks({ 'budget-reached:a1': '2026-10-20T11:00:00Z' })).kind).toBe('quiet')
    // A stop newer than its acknowledgement: the neutral line.
    const newer = acks({ 'budget-reached:a1': '2026-10-20T09:00:00Z', 'budget-scope:a1': '2026-10-20T11:00:00Z' })
    expect(state(makeOverview([stopped], [month]), roomy, false, newer).kind).toBe('quiet')
  })

  it('is the achievement when the runway and the budget room are both measured and holding', () => {
    const result = state(makeOverview([scout], [month]), roomy)
    // #3908: the title alone — exact equality pins that no body rides along.
    expect(result).toEqual({ kind: 'caught-up', title: ATTENTION_CAUGHT_UP_TITLE })
  })

  it('is the achievement at a zero pace too — nothing is drawing the balance down', () => {
    const result = state(makeOverview([scout], [{ ...month, usdcPace7dAtomic: '0' }]), roomy)
    expect(result).toEqual({ kind: 'caught-up', title: ATTENTION_CAUGHT_UP_TITLE })
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
    // BigInt('') is 0n — an empty string must not read as "nothing used".
    const empty = budgetRemaining([{ agent_id: 'a1', budget_atomic: '10000000', used_atomic: '' }])
    expect(state(makeOverview([scout], [month]), empty).kind).toBe('quiet')
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
