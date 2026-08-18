/**
 * #1557 — the sweep relay, characterized BEFORE the outbound record lands
 * (money.md §2: this is the funding leg's recovery path, so its existing
 * semantics are pinned first and must survive the plumbing change
 * bit-for-bit), then extended with the record's ordering assertions.
 *
 * Receipt semantics differ from the slice-2 sites and the tests encode why:
 * `provider.waitForTransaction` RESOLVES a mined-but-reverted receipt
 * (status 0) instead of throwing like `tx.wait()`, and resolves null on
 * timeout — where the tx may still land, so a timeout must leave the record
 * at `broadcast` for the #1558 unmined scan, never close it as failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const finishSpy = vi.fn(async () => {
  trace.push('spend:finish')
})
vi.mock('../../infra/relayer-spend-guard.js', () => ({
  assertRelayerBudget: vi.fn(async () => undefined),
  recordRelayerSpend: vi.fn(async () => 'spend-1'),
  finishRelayerSpend: finishSpy,
}))

// waitForTransaction outcome per test: a receipt object, or null (timeout).
let receiptOutcome: { status: number; gasUsed: bigint; gasPrice: bigint } | null = { status: 1, gasUsed: 90_000n, gasPrice: 7n }
const waitForTransaction = vi.fn(async () => receiptOutcome)

vi.mock('../allowance-module.js', () => ({
  getRelayerWallet: () => ({ provider: { waitForTransaction } }),
}))

const { relaySweepAuthorization } = await import('../sweep.js')

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
  vi.clearAllMocks()
})

describe('relaySweepAuthorization — characterization (#1557)', () => {
  it('happy path: broadcasts once, confirms by hash, stamps the #717 spend, returns the hash', async () => {
    const result = await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))
    expect(result.txHash).toBe(TX_HASH)
    expect(waitForTransaction).toHaveBeenCalledWith(TX_HASH, 1, 90_000)
    expect(finishSpy).toHaveBeenCalledTimes(1)
    expect(trace.filter((t) => t === 'broadcast')).toHaveLength(1)
  })

  it('a mined-but-REVERTED receipt (status 0, resolved not thrown) throws after the spend stamp', async () => {
    receiptOutcome = { status: 0, gasUsed: 90_000n, gasPrice: 7n }
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toThrow('reverted')
    expect(finishSpy).toHaveBeenCalledTimes(1)
  })

  it('a confirmation TIMEOUT (null receipt) throws — and never re-submits', async () => {
    receiptOutcome = null
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toThrow('not confirmed')
    expect(trace.filter((t) => t === 'broadcast')).toHaveLength(1)
  })
})

describe('relaySweepAuthorization — outbound record (#1557)', () => {
  it('opens the record BEFORE broadcasting, stamps it, closes mined on success', async () => {
    await relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish', 'record:mined'])
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
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish', 'record:failed'])
    expect(minedSpy).not.toHaveBeenCalled()
  })

  it('a TIMEOUT leaves the record at broadcast — the tx may still land; the unmined scan owns it', async () => {
    receiptOutcome = null
    await expect(relaySweepAuthorization(AUTH, '0x' + 'ab'.repeat(65))).rejects.toThrow('not confirmed')
    expect(trace).toEqual(['record:open', 'broadcast', 'spend:finish'])
    expect(minedSpy).not.toHaveBeenCalled()
    expect(failedSpy).not.toHaveBeenCalled()
  })
})
