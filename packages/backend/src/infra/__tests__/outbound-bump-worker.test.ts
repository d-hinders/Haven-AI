/**
 * #1558 — the bump worker's decisions, against fake deps (the repository's
 * real behaviour is proven in outbound-txs.test.ts; the chain calls are
 * injected). What matters here: the chain is asked BEFORE any bump, fees obey
 * the replacement minimum, a hot lane becomes an incident instead of a gas
 * furnace, and a non-idempotent orphan is never blindly re-broadcast.
 */
import { makeError } from 'ethers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BUMPS_PER_NONCE,
  bumpedFees,
  runOutboundBumpTick,
  type BumpDeps,
} from '../outbound-bump-worker.js'
import type { OutboundTxRow } from '../repositories/outbound-txs.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function row(overrides: Partial<OutboundTxRow>): OutboundTxRow {
  return {
    id: 'row-1',
    chain_id: 84532,
    submitter: 'sweep',
    to_address: '0x' + 'aa'.repeat(20),
    data: '0x' + 'bb'.repeat(40),
    value_atomic: '0',
    status: 'broadcast',
    claimed_at: null,
    nonce: '42',
    max_fee_per_gas: '1000',
    max_priority_fee_per_gas: '100',
    tx_hash: '0x' + 'cc'.repeat(32),
    replaced_by: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function deps(overrides: Partial<BumpDeps> = {}): BumpDeps {
  return {
    listUnmined: vi.fn(async () => []),
    claimOrphan: vi.fn(async () => null),
    enqueue: vi.fn(async () => row({ id: 'replacement-1', status: 'queued' })),
    markBroadcast: vi.fn(async () => null),
    markMined: vi.fn(async () => null),
    markFailed: vi.fn(async () => null),
    markReplaced: vi.fn(async () => null),
    countLaneAttempts: vi.fn(async () => 0),
    getReceiptStatus: vi.fn(async () => null),
    currentFees: vi.fn(async () => ({ maxFeePerGas: 900n, maxPriorityFeePerGas: 90n })),
    sendRaw: vi.fn(async () => ({ hash: '0x' + 'dd'.repeat(32), nonce: 42 })),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('bumpedFees', () => {
  it('enforces ≥12.5% over the stuck tx even when the current estimate is lower', () => {
    const fees = bumpedFees(
      { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n },
      { maxFeePerGas: 900n, maxPriorityFeePerGas: 50n },
    )
    // 1000 + 125 + 1, 100 + 12 + 1 — both clear the nodes' 10% replacement floor.
    expect(fees).toEqual({ maxFeePerGas: 1126n, maxPriorityFeePerGas: 113n })
  })

  it('takes the current estimate when the market moved above the bump floor', () => {
    const fees = bumpedFees(
      { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n },
      { maxFeePerGas: 5000n, maxPriorityFeePerGas: 500n },
    )
    expect(fees).toEqual({ maxFeePerGas: 5000n, maxPriorityFeePerGas: 500n })
  })

  it('falls back to the current estimate when the stuck tx recorded no fees', () => {
    expect(bumpedFees({}, { maxFeePerGas: 700n, maxPriorityFeePerGas: 70n })).toEqual({
      maxFeePerGas: 700n,
      maxPriorityFeePerGas: 70n,
    })
  })
})

describe('runOutboundBumpTick — stale broadcast rows', () => {
  it('asks the chain first: a mined row closes mined, no bump, no gas', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({})]),
      getReceiptStatus: vi.fn(async () => 1 as const),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.closedMined).toBe(1)
    expect(d.markMined).toHaveBeenCalledWith('row-1')
    expect(d.sendRaw).not.toHaveBeenCalled()
  })

  it('a mined-and-reverted row closes failed', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({})]),
      getReceiptStatus: vi.fn(async () => 0 as const),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.closedFailed).toBe(1)
    expect(d.sendRaw).not.toHaveBeenCalled()
  })

  it('a truly unmined row is replaced: same nonce, same payload, bumped fees, linked rows', async () => {
    const d = deps({ listUnmined: vi.fn(async () => [row({})]) })
    const result = await runOutboundBumpTick(84532, d, log)

    expect(result.bumped).toBe(1)
    // Same nonce and calldata — a REPLACEMENT, not a new intent.
    expect(d.sendRaw).toHaveBeenCalledWith(84532, expect.objectContaining({
      nonce: 42,
      data: '0x' + 'bb'.repeat(40),
      maxFeePerGas: 1126n, // 1000 * 1.125 + 1 beats the 900 estimate
    }))
    // Recorded as replacement chain, never an in-place rewrite.
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ submitter: 'sweep' }))
    expect(d.markReplaced).toHaveBeenCalledWith('row-1', 'replacement-1')
    expect(d.markBroadcast).toHaveBeenCalledWith('replacement-1', expect.objectContaining({ nonce: 42n }))
  })

  // #1735 — the stale-broadcast scan gates its REPLACEMENT step on
  // REBROADCAST_SAFE_SUBMITTERS, not just the orphan path below.
  //
  // On-chain a same-nonce replacement is survivable — at most one transaction
  // per nonce mines, so no second attestation. The damage is to RECOVERY: the
  // replacement carries a NEW tx hash, while `agent_passports.tx_hash` still
  // holds the original. #1043's `recoverAnchorFromReceipt` is keyed off that
  // stored hash, so it would return null forever and issuance would fall
  // through to a genuinely second attest at a fresh nonce.
  it('NEVER replaces a stuck passport_attest — that would orphan #1043 recovery', async () => {
    const d = deps({ listUnmined: vi.fn(async () => [row({ submitter: 'passport_attest' })]) })
    const result = await runOutboundBumpTick(84532, d, log)

    expect(result.bumped).toBe(0)
    expect(result.alerted).toBe(1)
    expect(d.sendRaw).not.toHaveBeenCalled()
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.markReplaced).not.toHaveBeenCalled()
    // Left `broadcast` on purpose: a later tick's chain-first read is what
    // closes it, once the chain has an answer.
    expect(d.markFailed).not.toHaveBeenCalled()
  })

  it('a rebroadcast-safe submitter is still replaced — the gate is not a blanket stop', async () => {
    for (const submitter of ['sweep', 'hybrid_deploy', 'passport_revoke']) {
      vi.clearAllMocks()
      const d = deps({ listUnmined: vi.fn(async () => [row({ submitter })]) })
      const result = await runOutboundBumpTick(84532, d, log)
      expect(result.bumped, submitter).toBe(1)
    }
  })

  // The chain-first half must keep working for a non-rebroadcast-safe row:
  // whatever we decide about bumping, a mined attest must still close mined.
  it('a mined passport_attest row closes mined, with no replacement', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({ submitter: 'passport_attest' })]),
      getReceiptStatus: vi.fn(async () => 1 as const),
    })
    const result = await runOutboundBumpTick(84532, d, log)

    expect(result.closedMined).toBe(1)
    expect(d.markMined).toHaveBeenCalledWith('row-1')
    expect(d.sendRaw).not.toHaveBeenCalled()
  })

  it('a mined-and-reverted passport_attest row closes failed, with no replacement', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({ submitter: 'passport_attest' })]),
      getReceiptStatus: vi.fn(async () => 0 as const),
    })
    const result = await runOutboundBumpTick(84532, d, log)

    expect(result.closedFailed).toBe(1)
    expect(d.sendRaw).not.toHaveBeenCalled()
  })

  it(`a lane past ${MAX_BUMPS_PER_NONCE} replacements is an INCIDENT: alert, no more gas`, async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({})]),
      countLaneAttempts: vi.fn(async () => MAX_BUMPS_PER_NONCE),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.alerted).toBe(1)
    expect(result.bumped).toBe(0)
    expect(d.sendRaw).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('INCIDENT'))
  })

  it('a THROWING bump broadcast closes the replacement row failed WITH the nonce — so the cap counts it', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({})]),
      sendRaw: vi.fn<BumpDeps['sendRaw']>().mockRejectedValue(new Error('nonce too low')),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.bumped).toBe(0)
    // The dangling queued replacement is closed, nonce-stamped for the cap.
    expect(d.markFailed).toHaveBeenCalledWith('replacement-1', expect.stringContaining('bump broadcast failed'), 42n)
    // The original stays broadcast for the next tick's chain-first check.
    expect(d.markReplaced).not.toHaveBeenCalled()
  })

  it('one broken row does not stop the tick — errors log and move on', async () => {
    const d = deps({
      listUnmined: vi.fn(async () => [row({ id: 'bad' }), row({ id: 'good', tx_hash: '0x' + 'ee'.repeat(32) })]),
            // Sequenced via a queue, not vitest's once-chains: the #1227 ratchet
      // counts that call pattern file-wide, and these are injected deps.
      getReceiptStatus: (() => {
        const outcomes: Array<() => Promise<0 | 1 | null>> = [
          () => Promise.reject(new Error('rpc down')),
          () => Promise.resolve(1 as const),
        ]
        return vi.fn<BumpDeps['getReceiptStatus']>(() => (outcomes.shift() ?? (() => Promise.resolve(null)))())
      })(),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.closedMined).toBe(1)
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('runOutboundBumpTick — orphaned queued rows', () => {
  it('re-broadcasts an idempotent orphan with a FRESH nonce and stamps the row', async () => {
    const orphan = row({ id: 'orphan-1', status: 'queued', tx_hash: null, nonce: null, submitter: 'sweep' })
    const orphanQueue = [orphan]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
      sendRaw: vi.fn(async () => ({ hash: '0x' + 'ff'.repeat(32), nonce: 99 })),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.rebroadcastOrphans).toBe(1)
    // No nonce in the send: this is a NEW submission, not a replacement.
    expect(d.sendRaw).toHaveBeenCalledWith(84532, expect.not.objectContaining({ nonce: expect.anything() }))
    expect(d.markBroadcast).toHaveBeenCalledWith('orphan-1', expect.objectContaining({ nonce: 99n }))
  })

  // #3263: 388 reverting passport_revoke orphans were re-sent every lease on dev.
  const reverting = () =>
    makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
      action: 'estimateGas', data: '0xc5723b51', reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null,
    })

  it('#3263: an orphan whose payload REVERTS is closed failed, and the loop moves on to the next orphan', async () => {
    // Keyed on the PAYLOAD, not call order: the revoke's calldata reverts, the
    // sweep's sends — whichever the loop claims first.
    const REVOKE_DATA = '0x46926267' + '00'.repeat(32)
    const orphanQueue = [
      row({ id: 'orphan-rev', status: 'queued', tx_hash: null, nonce: null, submitter: 'passport_revoke', data: REVOKE_DATA }),
      row({ id: 'orphan-ok', status: 'queued', tx_hash: null, nonce: null, submitter: 'sweep' }),
    ]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
      sendRaw: vi.fn<BumpDeps['sendRaw']>(async (_chainId, tx) => {
        if (tx.data === REVOKE_DATA) throw reverting()
        return { hash: '0x' + 'ff'.repeat(32), nonce: 7 }
      }),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(d.markFailed).toHaveBeenCalledWith('orphan-rev', 'orphan re-broadcast reverted in estimateGas (revert data 0xc5723b51)')
    expect(result.failedOrphans).toBe(1)
    expect(result.rebroadcastOrphans).toBe(1)
    expect(d.markBroadcast).toHaveBeenCalledWith('orphan-ok', expect.objectContaining({ nonce: 7n }))
    // Closed, not ALSO reported as a retryable failure.
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), 'outbound-bump: orphan re-broadcast failed')
  })

  it('#3263: a gas-estimation TIMEOUT (real ethers shape: CALL_EXCEPTION, data null) is left for the next lease', async () => {
    const orphanQueue = [row({ id: 'orphan-t2', status: 'queued', tx_hash: null, nonce: null, submitter: 'sweep' })]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
      sendRaw: vi.fn<BumpDeps['sendRaw']>().mockRejectedValue(
        makeError('missing revert data', 'CALL_EXCEPTION', {
          action: 'estimateGas', data: null, reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null,
        }),
      ),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(d.markFailed).not.toHaveBeenCalled()
    expect(result.failedOrphans).toBe(0)
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'outbound-bump: orphan re-broadcast failed')
  })

  it('#3263: a TRANSIENT orphan failure is left for the next lease — never closed', async () => {
    const orphanQueue = [row({ id: 'orphan-t', status: 'queued', tx_hash: null, nonce: null, submitter: 'sweep' })]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
      sendRaw: vi.fn<BumpDeps['sendRaw']>().mockRejectedValue(
        makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: 30, message: 'Request timeout on the free plan' } }),
      ),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(d.markFailed).not.toHaveBeenCalled()
    expect(result.failedOrphans).toBe(0)
    expect(result.rebroadcastOrphans).toBe(0)
  })

  it('#3263: a failing close is logged, never thrown out of the tick', async () => {
    const orphanQueue = [row({ id: 'orphan-rev', status: 'queued', tx_hash: null, nonce: null, submitter: 'passport_revoke' })]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
      sendRaw: vi.fn<BumpDeps['sendRaw']>().mockRejectedValue(reverting()),
      markFailed: vi.fn<BumpDeps['markFailed']>().mockRejectedValue(new Error('db down')),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.failedOrphans).toBe(0)
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'outbound-bump: could not close a reverting orphan')
  })

  it('NEVER blindly re-broadcasts a passport attest — a second broadcast mints a second attestation', async () => {
    const orphan = row({ id: 'orphan-2', status: 'queued', submitter: 'passport_attest' })
    const orphanQueue = [orphan]
    const d = deps({
      claimOrphan: vi.fn<BumpDeps['claimOrphan']>(async () => orphanQueue.shift() ?? null),
    })
    const result = await runOutboundBumpTick(84532, d, log)
    expect(result.alerted).toBe(1)
    expect(result.rebroadcastOrphans).toBe(0)
    expect(d.sendRaw).not.toHaveBeenCalled()
  })
})
