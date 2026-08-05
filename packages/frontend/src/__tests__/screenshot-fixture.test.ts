import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import { fixtureFor, SEED_STORAGE_KEYS, FIXTURE_EMPTY_FALLBACK } from '../../scripts/screenshot.mjs'
import { AUTH_TOKEN_STORAGE_KEY, ACTIVE_SAFE_STORAGE_KEY } from '../lib/auth-storage'
import {
  isMcpToolCallActivityItem,
  isPaymentActivityItem,
  type ActivityItem,
} from '../hooks/useAgentActivity'

const fx = fixtureFor as (apiPath: string, mode?: string) => Record<string, unknown> | null

describe('screenshot populated fixture (#896 follow-up)', () => {
  it('serves the populated shapes the hooks actually read', () => {
    // Each keyed endpoint returns the field its hook destructures — the exact
    // gaps that previously crashed routes render as error boundaries.
    expect(fx('/dashboard/overview')).toMatchObject({ totals: { usd: expect.any(Number) } })
    expect(fx('/portfolio/0x1111?chain_id=84532')).toMatchObject({ breakdown: expect.any(Array) })
    expect(fx('/balances/0x1111?chain_id=84532')).toMatchObject({ balances: expect.any(Array) })
    expect(fx('/agents')).toMatchObject({ agents: expect.any(Array) })
    expect(fx('/contacts')).toMatchObject({ contacts: expect.any(Array) })
    expect(fx('/chains')).toEqual({ deployable: [84532] })
  })

  it('distinguishes the three /transactions shapes', () => {
    // The aggregated feed (useTransactionsFeed):
    expect(fx('/transactions?offset=0&limit=25')).toMatchObject({ hasMore: false, failedSafeIds: [] })
    // Filter options (useTransactionFilters) — must NOT fall into the paginated branch:
    expect(fx('/transactions/filters')).toMatchObject({
      safes: expect.any(Array), agents: expect.any(Array), tokens: expect.any(Array),
    })
    // Safe-scoped paginated (useTransactions):
    expect(fx('/transactions/0x1111?page=1')).toMatchObject({ pages: 1, page: 1 })
  })

  it('regression-locks the shapes that crashed routes (timeAgo/timeUntil inputs)', () => {
    const approvals = fx('/approvals?status=all') as { approvals: { expires_at: string; created_at: string }[] }
    expect(approvals.approvals[0].expires_at).toBeTruthy() // ApprovalCard: timeUntil(expires_at)
    // SafeCard: timeAgo(safe.created_at) — served via /auth/me + /user/safes in the
    // script itself; asserted here through the agents' safe linkage staying non-null.
    const agents = fx('/agents') as { agents: { safe_id: string }[] }
    expect(agents.agents.every((a) => a.safe_id)).toBe(true)
  })

  it('SCREENSHOT_FIXTURE=empty falls through to the generic empty shape', () => {
    expect(fx('/dashboard/overview', 'empty')).toBeNull()
    expect(fx('/agents', 'empty')).toBeNull()
  })

  it('unkeyed endpoints fall through (null → generic empty shape)', () => {
    expect(fx('/agents/agent-1/delegations')).toBeNull()
    expect(fx('/reporting/summary')).toBeNull()
  })

  // #1075: /agents/[agentId] rendered nothing under the harness because
  // `/agent-activity/:id/activity` was unkeyed AND the generic fallback had no
  // `activity` key — useAgentActivity stored `undefined` and the page's
  // `.filter` over it took the route down. Both halves are pinned here.
  describe('agent activity (#1075)', () => {
    it('keys the agent-activity endpoints the detail page reads', () => {
      const activity = fx('/agent-activity/agent-research/activity') as { activity: ActivityItem[] }
      expect(activity.activity.length).toBeGreaterThan(0)

      expect(fx('/agent-activity/agent-research/stats')).toMatchObject({
        all_time: expect.any(Array),
        today: expect.any(Array),
        this_week: expect.any(Array),
        pending_approvals: expect.any(Number),
      })

      expect(fx('/agent-activity/feed')).toMatchObject({
        activity: expect.any(Array),
        pending_approvals: expect.any(Number),
      })
    })

    it('serves both activity variants in the shape the page discriminates on', () => {
      // The detail page splits the feed with these two guards; an item that
      // matches neither renders in no section at all.
      const { activity } = fx('/agent-activity/agent-research/activity') as {
        activity: ActivityItem[]
      }
      expect(activity.every((i) => isPaymentActivityItem(i) || isMcpToolCallActivityItem(i))).toBe(
        true,
      )
      expect(activity.some(isPaymentActivityItem)).toBe(true)
      expect(activity.some(isMcpToolCallActivityItem)).toBe(true)
      // Payment rows drive the unsettled-payment banner, so the field that
      // predicate reads must exist rather than being silently absent.
      for (const item of activity.filter(isPaymentActivityItem)) {
        expect(item).toHaveProperty('payment_attention_reason')
        expect(item.created_at).toBeTruthy() // timeAgo(created_at)
      }
    })

    it('orders the feed newest-first like the real route', () => {
      // The backend sorts the merged feed created_at-DESC, and the MCP-calls
      // panel renders in array order without re-sorting — an out-of-order
      // fixture would show a jumbled panel in the PR evidence.
      const { activity } = fx('/agent-activity/agent-research/activity') as {
        activity: ActivityItem[]
      }
      const times = activity.map((i) => Date.parse(i.created_at))
      expect(times).toEqual([...times].sort((a, b) => b - a))
    })

    it('carries `activity` in the generic empty fallback', () => {
      // SCREENSHOT_FIXTURE=empty (and any endpoint added later) must still
      // answer with an array here, not a missing key.
      expect(FIXTURE_EMPTY_FALLBACK).toMatchObject({ activity: [] })
      expect(fx('/agent-activity/agent-research/activity', 'empty')).toBeNull()
    })
  })

  it('seeds the SAME localStorage keys the app reads (parity with auth-storage)', () => {
    // A key rename in src/lib/auth-storage.ts must fail HERE — not silently
    // capture logged-out screenshots as PR evidence.
    expect(SEED_STORAGE_KEYS).toEqual({
      token: AUTH_TOKEN_STORAGE_KEY,
      activeSafe: ACTIVE_SAFE_STORAGE_KEY,
    })
  })
})
