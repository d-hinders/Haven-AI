/**
 * #4668 — the expired-budget answer's own clock re-check.
 *
 * `findExpiredBudgetForToken` is the shared expired-row lookup: the refusal
 * sites consult it on their already-refusing path, and the agent-facing
 * allowances read used to consult it unconditionally for `budget_ended_at`.
 * The narrow SQL filters `expires_at <= NOW()`, but the answer must never
 * call a LIVE row ended even if a source ignores that WHERE — the
 * defense-in-depth re-check against the reader's own clock.
 *
 * That clause had no direct test: `routes/__tests__/machine-payments.test.ts`
 * was its only coverage, and only by accident — its mock routes every
 * `FROM agent_delegations` query to one live row, so the `null` it asserted
 * came from this re-check rather than from the SQL. #4668's call-site guard
 * stops that test reaching this module at all (prove-red: removing the
 * re-check turned that test red before the guard landed), so the clause is
 * pinned here directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindExpired } = vi.hoisted(() => ({ mockFindExpired: vi.fn() }))

vi.mock('../../../infra/repositories/delegation-budgets.js', () => ({
  findExpiredDelegationForToken: (...args: unknown[]) => mockFindExpired(...args),
}))

import { findExpiredBudgetForToken } from '../expired-budget.js'

const AGENT = '11111111-1111-1111-1111-111111111111'
const CHAIN = 84532

function row(expiresAtSec: number) {
  return {
    id: 'd-1',
    delegation_hash: `0x${'dd'.repeat(32)}`,
    recipient_address: null,
    expires_at: String(expiresAtSec),
  }
}

describe('#4668 — findExpiredBudgetForToken', () => {
  beforeEach(() => {
    mockFindExpired.mockReset()
  })

  it('answers the row expiry when the row has ENDED', async () => {
    const endedSec = Math.floor(Date.now() / 1000) - 60
    mockFindExpired.mockResolvedValue(row(endedSec))

    const answer = await findExpiredBudgetForToken(AGENT, CHAIN, null)

    expect(answer).not.toBeNull()
    expect(answer?.endedAtSec).toBe(String(endedSec))
    expect(answer?.endedAtIso).toBe(new Date(endedSec * 1000).toISOString())
    expect(answer?.endedOnDate).toBe(new Date(endedSec * 1000).toISOString().slice(0, 10))
  })

  it('never calls a LIVE row ended — the clock re-check, even when the source ignores the WHERE', async () => {
    // The SQL filters `expires_at <= NOW()`; this row is in the future, so a
    // source that returned it anyway must still answer null.
    mockFindExpired.mockResolvedValue(row(Math.floor(Date.now() / 1000) + 3_600))

    expect(await findExpiredBudgetForToken(AGENT, CHAIN, null)).toBeNull()
  })

  it('answers null when there is no row', async () => {
    mockFindExpired.mockResolvedValue(null)

    expect(await findExpiredBudgetForToken(AGENT, CHAIN, null)).toBeNull()
  })

  it('answers null for an unrepresentable expiry rather than throwing', async () => {
    // `toISOString` throws RangeError past 8.64e15 ms; degraded storage
    // degrades to the generic refusal, never to garbage prose.
    mockFindExpired.mockResolvedValue(row(Number.MAX_SAFE_INTEGER))

    expect(await findExpiredBudgetForToken(AGENT, CHAIN, null)).toBeNull()
  })

  it('answers null for a non-positive expiry', async () => {
    mockFindExpired.mockResolvedValue(row(0))

    expect(await findExpiredBudgetForToken(AGENT, CHAIN, null)).toBeNull()
  })

  it('answers null when the read FAILS — best-effort by construction', async () => {
    mockFindExpired.mockRejectedValue(new Error('db down'))

    expect(await findExpiredBudgetForToken(AGENT, CHAIN, null)).toBeNull()
  })

  it('passes the token bind through, including the null that spans every token', async () => {
    mockFindExpired.mockResolvedValue(null)

    await findExpiredBudgetForToken(AGENT, CHAIN, null)
    expect(mockFindExpired).toHaveBeenLastCalledWith(AGENT, CHAIN, null)

    await findExpiredBudgetForToken(AGENT, CHAIN, '0x036cbd53842c5426634e7929541ec2318f3dcf7e')
    expect(mockFindExpired).toHaveBeenLastCalledWith(AGENT, CHAIN, '0x036cbd53842c5426634e7929541ec2318f3dcf7e')
  })
})
