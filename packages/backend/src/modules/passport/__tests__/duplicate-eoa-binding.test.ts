import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * #1042 — duplicate EOA bindings must not produce credential confusion.
 *
 * `agents.delegate_address` is client-supplied and unique only per-user among
 * non-revoked agents, so two anchored passports CAN legally reference the same
 * EOA over time. Three defenses, each pinned here:
 *
 * 1. The anchoring claim REFUSES while another agent's anchored, unrevoked
 *    passport binds the same EOA (checked under an EOA-keyed advisory lock so
 *    concurrent claims for the same address serialize).
 * 2. Issuance surfaces that refusal as a failed row with a distinct error —
 *    never a second anchor.
 * 3. The verifier's address lookup is deterministic: unrevoked-first, newest
 *    first — an old revoked binding can never shadow the live one.
 */

const mockQuery = vi.fn()
const mockRelease = vi.fn()
const mockConnect = vi.fn(async () => ({ query: mockQuery, release: mockRelease }))
vi.mock('../../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a), connect: () => mockConnect() },
}))

import { claimForAnchoring, FIND_BY_AGENT_ADDRESS_SQL } from '../../../infra/repositories/agent-passports.js'

beforeEach(() => {
  mockQuery.mockReset()
  mockRelease.mockReset()
})

describe('claimForAnchoring (#1042)', () => {
  it('refuses when another anchored, unrevoked passport binds the same EOA', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }) // bound-check hits
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    const outcome = await claimForAnchoring('agent-b', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect(outcome).toBe('eoa_already_bound')

    // The advisory lock is keyed on the LOWERCASED EOA and taken BEFORE the
    // bound-check — that ordering is what closes the concurrent-claim race.
    const calls = mockQuery.mock.calls.map(([sql]) => String(sql))
    const lockIdx = calls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
    const checkIdx = calls.findIndex((sql) => sql.includes("p2.status = 'anchored'"))
    expect(lockIdx).toBeGreaterThan(-1)
    expect(checkIdx).toBeGreaterThan(lockIdx)
    expect(mockQuery.mock.calls[lockIdx][1]).toEqual(['passport-eoa:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    // The check excludes revoked agents — a revoked holder must not block re-binding.
    expect(calls[checkIdx]).toMatch(/a2\.status <> 'revoked'/)
    expect(mockRelease).toHaveBeenCalled()
  })

  it('claims normally when the EOA is unbound', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // bound-check clean
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim UPDATE wins
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
    await expect(claimForAnchoring('agent-a', '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).resolves.toBe('claimed')
  })

  it('rolls back and releases on error', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('boom')) // advisory lock fails
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK
    await expect(claimForAnchoring('agent-a', '0xCC'.padEnd(42, 'c'))).rejects.toThrow('boom')
    expect(mockQuery.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK')
    expect(mockRelease).toHaveBeenCalled()
  })
})

describe('address resolution determinism (#1042)', () => {
  it('orders unrevoked-first, newest-first, with a stable tie-break', () => {
    expect(FIND_BY_AGENT_ADDRESS_SQL).toMatch(
      /ORDER BY \(a\.status <> 'revoked'\) DESC, p\.updated_at DESC, p\.agent_id/,
    )
    expect(FIND_BY_AGENT_ADDRESS_SQL).toMatch(/LIMIT 1/)
  })
})
