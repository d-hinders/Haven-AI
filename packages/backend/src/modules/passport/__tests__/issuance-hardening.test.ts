import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * #1043 — issuance hardening. Four defects from the adversarial review, each
 * pinned:
 *
 * 1. The due-list applies a capped exponential backoff (30s → 1h) computed
 *    from `updated_at + backoff(attempts)`, and excludes revoked agents.
 * 2. A broadcast whose result was lost is RECOVERED from its receipt on
 *    retry, never re-minted; the tx hash is persisted at broadcast time.
 * 3. Direct issuance refuses a revoked agent before claiming.
 * 4. The sweep counts rows past the attention threshold so the operator is
 *    alarmed instead of the row churning silently at the backoff cap.
 */

const mockQuery = vi.fn()
const mockRelease = vi.fn()
vi.mock('../../../db.js', () => ({
  default: {
    query: (...a: unknown[]) => mockQuery(...a),
    connect: async () => ({ query: (...a: unknown[]) => mockQuery(...a), release: mockRelease }),
  },
}))

import * as repo from '../../../infra/repositories/agent-passports.js'
import {
  issuePassport,
  retryPendingPassports,
  setAnchor,
  setAnchorRecovery,
  ISSUANCE_ATTENTION_ATTEMPTS,
} from '../issuance.js'

beforeEach(() => {
  mockQuery.mockReset()
  setAnchor(null)
  setAnchorRecovery(null)
  // Same load-bearing literal as passport-issuance.test.ts — the schema UID
  // must be configured or issuance fails before reaching claim/anchor.
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = '0x' + '1'.repeat(64)
})

describe('listRetryable backoff + revoked exclusion (#1043)', () => {
  it('computes due-ness from updated_at + capped exponential backoff, excluding revoked agents', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await repo.listRetryable(50)
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toMatch(/a\.status <> 'revoked'/)
    expect(sql).toMatch(/LEAST\(30 \* POWER\(2, LEAST\(GREATEST\(p\.attempts, 0\), 10\)\), 3600\)/)
    expect(sql).toMatch(/p\.updated_at < NOW\(\) - MAKE_INTERVAL/)
  })
})

describe('lost-result recovery (#1043)', () => {
  const FACTS = {
    rows: [{
      delegate_address: '0x' + 'a'.repeat(40), agent_status: 'active',
      chain_id: 84532, safe_address: '0x' + 'b'.repeat(40),
      account_type: null, execution_rail: null,
    }],
  }
  const pendingRow = (extra: Record<string, unknown>) => ({
    rows: [{
      agent_id: 'agent-1', status: 'pending', attestation_uid: null,
      tx_hash: null, chain_id: 84532, attempts: 1, ...extra,
    }],
  })

  it('recovers from the receipt instead of re-minting when a tx hash exists without a UID', async () => {
    const recovered = { attestationUid: '0x' + 'u'.repeat(64), txHash: '0x' + 'f'.repeat(64) }
    const anchor = vi.fn()
    const recovery = vi.fn(async () => recovered)
    setAnchor(anchor)
    setAnchorRecovery(recovery)

    mockQuery
      .mockResolvedValueOnce(pendingRow({ tx_hash: recovered.txHash })) // getPassport
      .mockResolvedValueOnce(FACTS) // findAgentFacts
      // claimForAnchoring transaction:
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // eoa bound-check clean
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim won
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      .mockResolvedValue({ rows: [], rowCount: 1 }) // markAnchored + everything after

    await issuePassport('agent-1', 'user-1')
    expect(recovery).toHaveBeenCalledWith(84532, recovered.txHash)
    expect(anchor).not.toHaveBeenCalled() // the whole point: no second mint
  })

  /**
   * AMENDED BY #1745. This test used to assert the opposite — that a null
   * from recovery FALLS THROUGH to a fresh anchor. That fall-through was the
   * defect: `getTransactionReceipt` returns null for a pending transaction
   * and a dropped one alike, so the fall-through minted a second live
   * credential behind a merely fee-stuck attest. A re-mint now needs positive
   * evidence of death from the liveness probe, and there is none wired here.
   *
   * The broadcast-hook half this test used to carry moved to
   * `presumed-dropped-attest.test.ts`, where the anchor path is exercised
   * from the state in which anchoring IS correct (no prior hash) — and
   * against real Postgres, so "the hash was persisted" is read back from the
   * row rather than pattern-matched against a mocked UPDATE.
   */
  it('does NOT fall through to a fresh anchor when recovery finds nothing (#1745)', async () => {
    const anchor = vi.fn()
    setAnchor(anchor)
    setAnchorRecovery(vi.fn(async () => null))

    mockQuery
      .mockResolvedValueOnce(pendingRow({ tx_hash: '0x' + '9'.repeat(64) })) // getPassport
      .mockResolvedValueOnce(FACTS)
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // bound-check
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [] }) // COMMIT
      .mockResolvedValue({ rows: [], rowCount: 1 })

    await issuePassport('agent-1', 'user-1')
    expect(anchor).not.toHaveBeenCalled()
  })

  it('refuses a revoked agent before claiming', async () => {
    setAnchor(vi.fn())
    mockQuery
      .mockResolvedValueOnce(pendingRow({})) // getPassport
      .mockResolvedValueOnce({ rows: [{ ...FACTS.rows[0], agent_status: 'revoked' }] }) // facts
      .mockResolvedValue({ rows: [], rowCount: 1 }) // markFailed + getPassport

    await issuePassport('agent-1', 'user-1')
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    // Failed with the revoked message; the claim transaction never started.
    expect(mockQuery.mock.calls.some(([, params]) =>
      Array.isArray(params) && params.some((v) => String(v).includes('revoked')))).toBe(true)
    expect(sqls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false)
  })
})

describe('sweep attention alarm (#1043)', () => {
  it('counts rows at or past the attention threshold', async () => {
    const spy = vi.spyOn(repo, 'listRetryable').mockResolvedValue([
      { agent_id: 'a', user_id: 'u', attempts: ISSUANCE_ATTENTION_ATTEMPTS },
      { agent_id: 'b', user_id: 'u', attempts: 2 },
    ])
    // issuePassport will fail fast for both (getPassport returns nothing).
    mockQuery.mockResolvedValue({ rows: [] })
    const result = await retryPendingPassports()
    expect(result.needingAttention).toBe(1)
    spy.mockRestore()
  })
})
