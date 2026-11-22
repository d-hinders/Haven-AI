/**
 * #5035 — the delegate-sweep confirmer's decision layer.
 *
 * The decision is chain state, not a hash: `authorizationState(from, nonce)` is
 * the authority (an EIP-3009 nonce is single-use), and the mined hash is only
 * needed for attribution. These tests drive the decision with injected deps —
 * no database, no RPC — and pin every branch: used+mined, used+no-hash,
 * unused+expired, unused+still-valid, and a read failure.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  confirmOutcomeUnknownSweep,
  runSweepConfirmerTick,
  type OutcomeUnknownSweepInput,
  type SweepConfirmerDeps,
} from '../sweep-confirmer.js'

const TX = '0x' + 'ef'.repeat(32)
const REPLACEMENT = '0x' + 'aa'.repeat(32)

function row(overrides: Partial<OutcomeUnknownSweepInput> = {}): OutcomeUnknownSweepInput {
  return {
    id: 'sweep-1',
    agentId: 'agent-1',
    chainId: 8453,
    tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    fromAddress: '0x' + '11'.repeat(20),
    nonce: '0x' + '22'.repeat(32),
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    txHash: TX,
    ...overrides,
  }
}

function deps(overrides: Partial<SweepConfirmerDeps> = {}): SweepConfirmerDeps {
  return {
    readAuthorizationState: vi.fn(async () => true),
    findMinedHash: vi.fn(async () => TX),
    markSubmitted: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    resolveStranded: vi.fn(async () => undefined),
    now: () => Date.now(),
    ...overrides,
  }
}

describe('confirmOutcomeUnknownSweep', () => {
  it('authorization used + mined hash found → submitted with that hash, and the stranded event resolves', async () => {
    const d = deps()
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'submitted', txHash: TX })
    expect(d.markSubmitted).toHaveBeenCalledWith(TX, 'sweep-1')
    expect(d.resolveStranded).toHaveBeenCalledWith('agent-1')
  })

  it('authorization used under a REPLACEMENT hash → submitted with the replacement hash (attribution follows the mined tx)', async () => {
    const d = deps({ findMinedHash: vi.fn(async () => REPLACEMENT) })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'submitted', txHash: REPLACEMENT })
    expect(d.markSubmitted).toHaveBeenCalledWith(REPLACEMENT, 'sweep-1')
  })

  it('authorization used but no mined hash found → unresolved, nothing written, nothing resolved', async () => {
    const d = deps({ findMinedHash: vi.fn(async () => null) })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'unresolved' })
    expect(d.markSubmitted).not.toHaveBeenCalled()
    expect(d.resolveStranded).not.toHaveBeenCalled()
  })

  it('a lost CAS (markSubmitted returns false) → unresolved, and the stranded event is NOT resolved', async () => {
    const d = deps({ markSubmitted: vi.fn(async () => false) })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'unresolved' })
    expect(d.resolveStranded).not.toHaveBeenCalled()
  })

  it('authorization unused and past validBefore → failed_expired', async () => {
    const d = deps({
      readAuthorizationState: vi.fn(async () => false),
      now: () => (Number(row().validBefore) + 1) * 1000,
    })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'failed_expired' })
    expect(d.markFailed).toHaveBeenCalledWith(
      'Sweep authorization expired unused — the transaction never landed',
      'sweep-1',
    )
    expect(d.markSubmitted).not.toHaveBeenCalled()
  })

  it('authorization unused but still valid → unresolved (the next tick retries)', async () => {
    const d = deps({ readAuthorizationState: vi.fn(async () => false) })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'unresolved' })
    expect(d.markFailed).not.toHaveBeenCalled()
  })

  it('a chain read failure (null) leaves the row unresolved — never a terminal booking', async () => {
    const d = deps({ readAuthorizationState: vi.fn(async () => null) })
    const decision = await confirmOutcomeUnknownSweep(row(), d)
    expect(decision).toEqual({ outcome: 'unresolved' })
    expect(d.markSubmitted).not.toHaveBeenCalled()
    expect(d.markFailed).not.toHaveBeenCalled()
  })

  it('a thrown read propagates to the tick, which leaves the row unresolved', async () => {
    const d = deps({
      readAuthorizationState: vi.fn(async () => {
        throw new Error('rpc down')
      }),
    })
    await expect(confirmOutcomeUnknownSweep(row(), d)).rejects.toThrow('rpc down')
    expect(d.markSubmitted).not.toHaveBeenCalled()
    expect(d.markFailed).not.toHaveBeenCalled()
  })
})

describe('runSweepConfirmerTick', () => {
  it('counts each decision and never lets one poison row silence the rest', async () => {
    const dbRow = (id: string) => ({
      id,
      agent_id: 'agent-1',
      user_id: 'u',
      chain_id: 8453,
      token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      from_address: '0x' + '11'.repeat(20),
      to_address: '0x' + '33'.repeat(20),
      value_atomic: '100000',
      valid_after: '0',
      valid_before: String(Math.floor(Date.now() / 1000) + 300),
      nonce: '0x' + '22'.repeat(32),
      status: 'outcome_unknown',
      tx_hash: TX,
      created_at: new Date(),
    })
    const rows = [dbRow('a'), dbRow('b'), dbRow('c')]
    // Per-row outcomes by call order: a → used, b → read throws, c → unused.
    let call = 0
    const readAuthorizationState = vi.fn(async () => {
      call += 1
      if (call === 1) return true
      if (call === 2) throw new Error('rpc down')
      return false
    })
    const d = deps({
      findCandidates: vi.fn(async () => rows),
      readAuthorizationState,
    })
    const log = { info: vi.fn(), warn: vi.fn() }

    const result = await runSweepConfirmerTick(log, d)

    expect(result).toEqual({ candidates: 3, submitted: 1, failedExpired: 0, unresolved: 2 })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('an empty candidate set is a no-op', async () => {
    const d = deps({ findCandidates: vi.fn(async () => []) })
    const result = await runSweepConfirmerTick({ info: vi.fn(), warn: vi.fn() }, d)
    expect(result).toEqual({ candidates: 0, submitted: 0, failedExpired: 0, unresolved: 0 })
  })
})
