/**
 * #1557 — the sweep relay, characterized BEFORE the outbound record lands
 * (money.md §2: this is the funding leg's recovery path, so its existing
 * semantics are pinned first and must survive the plumbing change
 * bit-for-bit), then extended with the record's ordering assertions.
 *
 * Receipt semantics differ from the slice-2 sites and the tests encode why:
 * `provider.waitForTransaction` RESOLVES a mined-but-reverted receipt
 * (status 0) instead of throwing like `tx.wait()`, and — #5035 — ethers 6
 * REJECTS a timed-out wait with a `TIMEOUT` error carrying no hash. A timeout
 * is NOT failure: the tx is broadcast and may still land, so the rail raises
 * `SweepOutcomeUnknownError` carrying the hash and leaves the record at
 * `broadcast` for the #1558 unmined scan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeError } from 'ethers'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TX_HASH = '0x' + 'ba'.repeat(32)
const trace: string[] = []

type Stamp = { hash: string; nonce: number | bigint }
const broadcastSpy = vi.fn(async (stamp: Stamp) => {
  trace.push('record:broadcast')
  void stamp
})
const minedSpy = vi.fn(async () => {
  trace.push('record:mined')
})
const failedSpy = vi.fn(async (reason: string) => {
  trace.push('record:failed')
  void reason
})
const openSpy = vi.fn(async (params: { submitter: string; to: string; data: string }) => {
  trace.push('record:open')
  void params
  return { id: 'rec-1', broadcast: broadcastSpy, mined: minedSpy, failed: failedSpy }
})
const submitSpy = vi.fn(async (params: { recordId: string | null }) => {
  trace.push('broadcast')
  void params
  return { hash: TX_HASH, nonce: 11 }
})
vi.mock('../../infra/outbound-queue.js', () => ({
  openOutboundRecord: openSpy,
  submitRecorded: submitSpy,
}))

// #5035: the rail reads the outbound record after a send throw to decide
// whether the transaction was stamped (and so may still land).
const findOutboundTxByIdSpy = vi.fn(async () => null as { status: string; tx_hash: string | null } | null)
vi.mock('../../infra/repositories/outbound-txs.js', () => ({
  findOutboundTxById: findOutboundTxByIdSpy,
}))

const finishSpy = vi.fn(async () => {
  trace.push('spend:finish')
})
vi.mock('../../infra/relayer-spend-guard.js', () => ({
  assertRelayerBudget: vi.fn(async () => undefined),
  recordRelayerSpend: vi.fn(async () => 'spend-1'),
  finishRelayerSpend: finishSpy,
}))

// waitForTransaction outcome per test: a receipt object, or a rejection.
let receiptOutcome: { status: number; gasUsed: bigint; gasPrice: bigint } | null = { status: 1, gasUsed: 90_000n, gasPrice: 7n }
let waitRejection: unknown = null
const waitForTransaction = vi.fn(async () => {
  trace.push('wait')
  if (waitRejection) throw waitRejection
  return receiptOutcome
})

vi.mock('../../infra/chain/relayer-reads.js', () => ({
  getRelayerWallet: () => ({ provider: { waitForTransaction } }),
}))

const { relaySweepAuthorization, SweepOutcomeUnknownError, SWEEP_SYNC_CONFIRMATION_TIMEOUT_MS } =
  await import('../sweep.js')

const AUTH = {
  chainId: 84532,
  token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  from: '0x' + '55'.repeat(20),
  to: '0x' + '66'.repeat(20),
  value: '123456',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: '0x' + '0f'.repeat(32),
} as Parameters<typeof relaySweepAuthorization>[0]

beforeEach(() => {
  trace.length = 0
  receiptOutcome = { status: 1, gasUsed: 90_000n, gasPrice: 7n }
  waitRejection = null
  vi.clearAllMocks()
  findOutboundTxByIdSpy.mockReset()
  findOutboundTxByIdSpy.mockResolvedValue(null)
})

describe('relaySweepAuthorization — characterization (#1557)', () => {
  it('happy path: broadcasts once, confirms by hash, stamps the #717 spend, returns the hash', async () => {
    const result = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))
    expect(result.txHash).toBe(TX_HASH)
    expect(waitForTransaction).toHaveBeenCalledWith(TX_HASH, 1, SWEEP_SYNC_CONFIRMATION_TIMEOUT_MS)
    expect(finishSpy).toHaveBeenCalledTimes(2)
    expect(trace.filter((t) => t === 'broadcast')).toHaveLength(1)
  })

  it('a mined-but-REVERTED receipt (status 0, resolved not thrown) throws after the spend stamp', async () => {
    receiptOutcome = { status: 0, gasUsed: 90_000n, gasPrice: 7n }
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toThrow('reverted')
    expect(finishSpy).toHaveBeenCalledTimes(2)
  })

  it('a confirmation TIMEOUT (ethers REJECTS with TIMEOUT) raises outcome-unknown carrying the hash — and never re-submits', async () => {
    waitRejection = makeError('timeout', 'TIMEOUT')
    const err = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65)).catch((e) => e)
    expect(err).toBeInstanceOf(SweepOutcomeUnknownError)
    expect((err as InstanceType<typeof SweepOutcomeUnknownError>).txHash).toBe(TX_HASH)
    expect(trace.filter((t) => t === 'broadcast')).toHaveLength(1)
  })
})

describe('relaySweepAuthorization — outbound record (#1557)', () => {
  it('opens the record BEFORE broadcasting, stamps it, closes mined on success', async () => {
    await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))
    expect(trace).toEqual([
      'record:open',
      'broadcast',
      'spend:finish',
      'wait',
      'spend:finish',
      'record:mined',
    ])
    const opened = openSpy.mock.calls[0][0]
    expect(opened).toMatchObject({ submitter: 'sweep', to: AUTH.token })
    // The record carries the exact transferWithAuthorization calldata a bump
    // would re-broadcast — selector included (0xcf092995: the bytes-signature EIP-3009 variant this relay uses).
    expect(opened.data.startsWith('0xcf092995')).toBe(true)
    // Fence wiring: the pipeline gets the record id and the same calldata.
    const submitted = submitSpy.mock.calls[0][0] as { recordId: string; data: string }
    expect(submitted.recordId).toBe('rec-1')
    expect(submitted.data.startsWith('0xcf092995')).toBe(true)
  })

  it('a resolved status-0 receipt closes the record FAILED', async () => {
    receiptOutcome = { status: 0, gasUsed: 90_000n, gasPrice: 7n }
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toThrow('reverted')
    expect(trace).toEqual([
      'record:open',
      'broadcast',
      'spend:finish',
      'wait',
      'spend:finish',
      'record:failed',
    ])
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('a TIMEOUT leaves the record at broadcast — the tx may still land; the unmined scan owns it', async () => {
    waitRejection = makeError('timeout', 'TIMEOUT')
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toBeInstanceOf(
      SweepOutcomeUnknownError,
    )
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish', 'wait'])
    expect(minedSpy).not.toHaveBeenCalled()
    expect(failedSpy).not.toHaveBeenCalled()
  })
})

describe('relaySweepAuthorization — #5035 outcome-unknown', () => {
  it('stamps the relayer-spend hash BEFORE the wait, so a rejected wait still leaves the hash on the row', async () => {
    waitRejection = makeError('timeout', 'TIMEOUT')
    await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65)).catch(() => undefined)
    // First finish call is the pre-wait stamp, carrying only the hash.
    expect(finishSpy.mock.calls[0]).toEqual(['spend-1', { txHash: TX_HASH }])
    // And it happened before the wait.
    expect(trace.indexOf('spend:finish')).toBeLessThan(trace.indexOf('wait'))
  })

  it('a lost broadcast answer (submitRecorded throws after the stamp) raises outcome-unknown with the hash and stamps the spend', async () => {
    submitSpy.mockImplementationOnce(async () => {
      trace.push('broadcast')
      throw new Error('socket hang up')
    })
    findOutboundTxByIdSpy.mockResolvedValue({ status: 'broadcast', tx_hash: TX_HASH })
    const err = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65)).catch((e) => e)
    expect(err).toBeInstanceOf(SweepOutcomeUnknownError)
    expect((err as InstanceType<typeof SweepOutcomeUnknownError>).txHash).toBe(TX_HASH)
    expect(finishSpy).toHaveBeenCalledWith('spend-1', { txHash: TX_HASH })
    expect(waitForTransaction).not.toHaveBeenCalled()
    expect(minedSpy).not.toHaveBeenCalled()
    expect(failedSpy).not.toHaveBeenCalled()
  })

  it('a send throw whose record was NOT stamped (still queued) propagates unchanged — a pre-broadcast failure stays a failure', async () => {
    submitSpy.mockImplementationOnce(async () => {
      trace.push('broadcast')
      throw new Error('gas estimation failed')
    })
    findOutboundTxByIdSpy.mockResolvedValue({ status: 'queued', tx_hash: null })
    const err = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65)).catch((e) => e)
    expect(err).not.toBeInstanceOf(SweepOutcomeUnknownError)
    expect((err as Error).message).toBe('gas estimation failed')
    expect(waitForTransaction).not.toHaveBeenCalled()
  })

  it('a provider that RESOLVES null instead of rejecting is also outcome-unknown, not failure', async () => {
    receiptOutcome = null
    const err = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65)).catch((e) => e)
    expect(err).toBeInstanceOf(SweepOutcomeUnknownError)
    expect((err as InstanceType<typeof SweepOutcomeUnknownError>).txHash).toBe(TX_HASH)
    expect(failedSpy).not.toHaveBeenCalled()
  })

  // #5035 acceptance criterion 5: the synchronous wait must end BEFORE the
  // hosted client gives up, or the agent sees a transport timeout and never
  // learns the hash. The SDK transport's default request timeout is the budget
  // this wait has to fit inside; it is module-private, so the relationship is
  // pinned against the source constant. Raising the wait back past the client
  // budget (the pre-#5035 90 s) goes red here.
  it('the synchronous wait fits inside the SDK transport default request timeout', () => {
    const sdkSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../sdk/src/haven-api-transport.ts'),
      'utf8',
    )
    const match = sdkSource.match(/const DEFAULT_REQUEST_TIMEOUT = ([\d_]+)/)
    expect(match).not.toBeNull()
    const clientBudgetMs = Number(match![1].replace(/_/g, ''))
    expect(clientBudgetMs).toBeGreaterThan(0)
    expect(SWEEP_SYNC_CONFIRMATION_TIMEOUT_MS).toBeLessThan(clientBudgetMs)
  })
})
