import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the cast below
import { fixtureFor, SEED_STORAGE_KEYS } from '../../scripts/screenshot.mjs'
import { AUTH_TOKEN_STORAGE_KEY, ACTIVE_SAFE_STORAGE_KEY } from '../lib/auth-storage'

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

  it('seeds the SAME localStorage keys the app reads (parity with auth-storage)', () => {
    // A key rename in src/lib/auth-storage.ts must fail HERE — not silently
    // capture logged-out screenshots as PR evidence.
    expect(SEED_STORAGE_KEYS).toEqual({
      token: AUTH_TOKEN_STORAGE_KEY,
      activeSafe: ACTIVE_SAFE_STORAGE_KEY,
    })
  })
})
