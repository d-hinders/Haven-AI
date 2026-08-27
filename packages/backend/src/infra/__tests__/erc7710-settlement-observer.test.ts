/**
 * Unit tests for the erc7710 settlement observer (#2117) — discovery,
 * completion, and the per-tick scan. The on-chain seam (provider getLogs /
 * verifySettlementTransferTx) is mocked at the module boundary; the REAL
 * eligibility SQL is covered by the real-DB suite
 * (`repositories/__tests__/erc7710-observer-eligibility.test.ts`).
 *
 * Integrity properties pinned here:
 * - NOTHING completes without a `verified` verdict from the verifier —
 *   discovery is candidate-finding only, rpc_unavailable is never a verdict.
 * - a confirmed observation must ALSO produce the evidence row (that is the
 *   Fortnox feed); if the evidence write throws, the confirm is still real
 *   and reported as such.
 * - one failing intent never aborts the rest of the tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const mocks = vi.hoisted(() => ({
  findPendingErc7710Settlements: vi.fn(),
  maxAge: 780,
  findIntentEvidenceSource: vi.fn(),
  recordMachinePaymentEvidenceBase: vi.fn(),
  observeErc7710Settlement: vi.fn(),
  expectedSettlementTransferFor: vi.fn(),
  verifySettlementTransferTx: vi.fn(),
  getProvider: vi.fn(),
  withKeyedAdvisoryLock: vi.fn(),
}))

vi.mock('../repositories/x402-authorizations.js', () => ({
  findPendingErc7710Settlements: mocks.findPendingErc7710Settlements,
  ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS: mocks.maxAge,
}))
vi.mock('../repositories/machine-payments.js', () => ({
  findIntentEvidenceSource: mocks.findIntentEvidenceSource,
}))
vi.mock('../../modules/mpp/evidence.js', () => ({
  recordMachinePaymentEvidenceBase: mocks.recordMachinePaymentEvidenceBase,
}))
vi.mock('../../modules/x402/settlement-observed.js', () => ({
  observeErc7710Settlement: mocks.observeErc7710Settlement,
  expectedSettlementTransferFor: mocks.expectedSettlementTransferFor,
}))
vi.mock('../chain/settlement-transfer-verifier.js', () => ({
  verifySettlementTransferTx: mocks.verifySettlementTransferTx,
  ERC20_TRANSFER_TOPIC: ethers.id('Transfer(address,address,uint256)'),
}))
vi.mock('../../rails/allowance-module.js', () => ({
  getProvider: mocks.getProvider,
}))
vi.mock('../../platform/leader-lock.js', () => ({
  withKeyedAdvisoryLock: mocks.withKeyedAdvisoryLock,
  KEYED_LOCK_NAMESPACES: { settlementObservation: 811102 },
}))

import {
  completeObservedErc7710Settlement,
  discoverSettlementTransferHash,
  runErc7710SettlementObserver,
} from '../erc7710-settlement-observer.js'
import type { ExpectedSettlementTransfer } from '../chain/settlement-transfer-verifier.js'
import type { ObservableSettlementIntent } from '../../modules/x402/settlement-observed.js'

const NOW_SEC = Math.floor(Date.now() / 1000)

const EXPECTED: ExpectedSettlementTransfer = {
  chainId: 8453,
  tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  fromAddress: '0x000000000000000000000000000000000000f1',
  toAddress: '0x000000000000000000000000000000000000aa',
  amountRaw: '100000',
  // Realistic recent window: with an assumed 2s block this yields a nonzero,
  // generously-wide discovery range while staying far inside the RPC head.
  notBeforeSec: NOW_SEC - 2000,
  notAfterSec: NOW_SEC + 800,
}

type MockFn = ReturnType<typeof vi.fn>
function fakeProvider(overrides: Partial<{ getBlock: MockFn; getLogs: MockFn }> = {}) {
  return {
    getBlock: vi.fn().mockResolvedValue({ number: 1_000_000 }),
    getLogs: vi.fn().mockResolvedValue([{ transactionHash: '0xsettle' }]),
    ...overrides,
  }
}

const INTENT: ObservableSettlementIntent = {
  id: 'intent-1',
  agent_id: 'agent-1',
  chain_id: 8453,
  safe_address: EXPECTED.fromAddress,
  to_address: EXPECTED.toAddress,
  token_symbol: 'USDC',
  token_address: EXPECTED.tokenAddress,
  amount_raw: EXPECTED.amountRaw,
  amount_human: '0.1',
  status: 'submitted',
  tx_hash: null,
  created_at: '2026-08-27T00:00:00.000Z',
  execution_rail: 'delegation',
  machine_metadata: { settlement_scheme: 'erc7710' },
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
}

describe('discoverSettlementTransferHash (candidate finding, never a verdict)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.withKeyedAdvisoryLock.mockImplementation(async (_ns: number, _subj: string, fn: () => Promise<unknown>) => fn())
    mocks.getProvider.mockReturnValue(fakeProvider())
  })

  it('returns the hash only when the verifier says verified', async () => {
    mocks.verifySettlementTransferTx.mockResolvedValue({ outcome: 'verified' })
    const probe = fakeProvider()
    mocks.getProvider.mockReturnValue(probe)

    const result = await discoverSettlementTransferHash(EXPECTED)
    expect(result).toEqual({ status: 'found', txHash: '0xsettle' })

    // The log scan is a CANDIDATE filter keyed on token + indexed from/to….
    const [filter] = probe.getLogs.mock.calls[0]
    expect(filter.address).toBe(EXPECTED.tokenAddress)
    expect(filter.topics[0]).toBe(ethers.id('Transfer(address,address,uint256)'))
    expect(filter.topics[1]).toBe(ethers.zeroPadValue(EXPECTED.fromAddress, 32))
    expect(filter.topics[2]).toBe(ethers.zeroPadValue(EXPECTED.toAddress, 32))
    // …and the range is generously wide (nothing narrow can drop a genuine
    // settlement; the exact gate is the verifier's own window clamp).
    expect(probe.getLogs.mock.calls[0][0].fromBlock).toBeGreaterThan(0)
  })

  it('maps getBlock/getLogs transport failures to rpc_unavailable, never a verdict', async () => {
    mocks.getProvider.mockReturnValue(
      fakeProvider({
        getBlock: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    )
    expect(await discoverSettlementTransferHash(EXPECTED)).toEqual({ status: 'rpc_unavailable' })

    mocks.getProvider.mockReturnValue(
      fakeProvider({
        getLogs: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    )
    expect(await discoverSettlementTransferHash(EXPECTED)).toEqual({ status: 'rpc_unavailable' })
  })

  it('treats a verifier rpc_unavailable as rpc_unavailable (stop, retry whole intent)', async () => {
    mocks.verifySettlementTransferTx.mockResolvedValue({ outcome: 'rpc_unavailable', reason: 'down' })
    expect(await discoverSettlementTransferHash(EXPECTED)).toEqual({ status: 'rpc_unavailable' })
  })

  it('continues past mismatch/reverted candidates and returns no_candidate on none', async () => {
    mocks.getProvider.mockReturnValue(
      fakeProvider({
        getLogs: vi.fn().mockResolvedValue([
          { transactionHash: '0xone' },
          { transactionHash: null },
          { transactionHash: '0xthree' },
        ]),
      }),
    )
    let verifyCall = 0
    mocks.verifySettlementTransferTx.mockImplementation(async () => {
      verifyCall += 1
      return verifyCall === 1
        ? { outcome: 'mismatch', reason: 'not this' }
        : { outcome: 'reverted', reason: 'no' }
    })
    expect(await discoverSettlementTransferHash(EXPECTED)).toEqual({ status: 'no_candidate' })
    expect(mocks.verifySettlementTransferTx).toHaveBeenCalledTimes(2)
  })
})

describe('completeObservedErc7710Settlement (confirm then EVIDENCE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.withKeyedAdvisoryLock.mockImplementation(async (_ns: number, _subj: string, fn: () => Promise<unknown>) => fn())
  })

  it('confirmed observation → reload → evidence row → Fortnox feed', async () => {
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'confirmed' })
    mocks.findIntentEvidenceSource.mockResolvedValue({ ...INTENT, status: 'confirmed', tx_hash: '0xsettle' })
    mocks.recordMachinePaymentEvidenceBase.mockResolvedValue(undefined)

    const result = await completeObservedErc7710Settlement(INTENT, '0xsettle')
    expect(result).toEqual({ confirmed: true, evidencePushed: true, evidenceFailed: false })
    // The evidence write is the whole point: it is what fires the Fortnox feed.
    expect(mocks.recordMachinePaymentEvidenceBase).toHaveBeenCalledTimes(1)
    expect(mocks.recordMachinePaymentEvidenceBase.mock.calls[0][0]).toMatchObject({
      status: 'confirmed',
      tx_hash: '0xsettle',
    })
    // Runs inside the per-intent keyed advisory lock (serialises vs the HTTP path).
    expect(mocks.withKeyedAdvisoryLock).toHaveBeenCalledWith(811102, 'intent-1', expect.any(Function))
  })

  it('a refused/unverified confirmation writes NOTHING (fail closed)', async () => {
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'unverified', retryable: false, reason: 'no' })
    const result = await completeObservedErc7710Settlement(INTENT, '0xsettle')
    expect(result.confirmed).toBe(false)
    expect(result.refusedReason).toBe('unverified')
    expect(mocks.recordMachinePaymentEvidenceBase).not.toHaveBeenCalled()
  })

  it('a raced observation (not_applicable) writes NOTHING', async () => {
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'not_applicable' })
    const result = await completeObservedErc7710Settlement(INTENT, '0xsettle')
    expect(result).toEqual({ confirmed: false, evidencePushed: false, evidenceFailed: false, refusedReason: 'not_applicable' })
    expect(mocks.recordMachinePaymentEvidenceBase).not.toHaveBeenCalled()
  })

  it('a thrown evidence write never fakes a failed CONFIRM — reported separately', async () => {
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'confirmed' })
    mocks.findIntentEvidenceSource.mockResolvedValue({ ...INTENT, status: 'confirmed', tx_hash: '0xsettle' })
    mocks.recordMachinePaymentEvidenceBase.mockRejectedValue(new Error('db down'))

    const result = await completeObservedErc7710Settlement(INTENT, '0xsettle')
    expect(result).toEqual({
      confirmed: true,
      evidencePushed: false,
      evidenceFailed: true,
      refusedReason: 'db down',
    })
  })

  it('a missing reload leaves the intent confirmed but reports no evidence push', async () => {
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'confirmed' })
    mocks.findIntentEvidenceSource.mockResolvedValue(null)
    const result = await completeObservedErc7710Settlement(INTENT, '0xsettle')
    expect(result).toEqual({ confirmed: true, evidencePushed: false, evidenceFailed: false })
  })
})

describe('runErc7710SettlementObserver (per-tick scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.withKeyedAdvisoryLock.mockImplementation(async (_ns: number, _subj: string, fn: () => Promise<unknown>) => fn())
    mocks.expectedSettlementTransferFor.mockReturnValue(EXPECTED)
  })

  it('completes found settlements and reports the skips honestly', async () => {
    mocks.findPendingErc7710Settlements.mockResolvedValue([{ ...INTENT, id: 'a' }, { ...INTENT, id: 'b' }])
    const provider = fakeProvider()
    mocks.getProvider.mockReturnValue(provider)
    mocks.verifySettlementTransferTx.mockResolvedValue({ outcome: 'verified' })
    mocks.findIntentEvidenceSource.mockResolvedValue({ ...INTENT, status: 'confirmed', tx_hash: '0xsettle' })
    mocks.recordMachinePaymentEvidenceBase.mockResolvedValue(undefined)
    // First intent: verified + confirmed + evidence. Second: nothing on-chain.
    mocks.observeErc7710Settlement.mockResolvedValue({ outcome: 'confirmed' })
    let logCall = 0
    provider.getLogs.mockImplementation(async () => {
      logCall += 1
      return logCall === 1 ? [{ transactionHash: '0xsettle' }] : []
    })

    const report = await runErc7710SettlementObserver(log)
    expect(report).toMatchObject({ pending: 2, confirmed: 1, evidencePushed: 1, skippedNoCandidate: 1, skippedRpcUnavailable: 0 })
  })

  it('a failing intent never aborts the rest of the tick', async () => {
    mocks.findPendingErc7710Settlements.mockResolvedValue([{ ...INTENT, id: 'a' }, { ...INTENT, id: 'b' }])
    const provider = fakeProvider()
    mocks.getProvider.mockReturnValue(provider)
    mocks.verifySettlementTransferTx.mockResolvedValue({ outcome: 'verified' })
    let obsCall = 0
    mocks.observeErc7710Settlement.mockImplementation(async () => {
      obsCall += 1
      if (obsCall === 1) throw new Error('lock boom')
      return { outcome: 'confirmed' }
    })
    mocks.findIntentEvidenceSource.mockResolvedValue({ ...INTENT, status: 'confirmed', tx_hash: '0xsettle' })
    mocks.recordMachinePaymentEvidenceBase.mockResolvedValue(undefined)

    const report = await runErc7710SettlementObserver(log)
    expect(report).toMatchObject({ pending: 2, confirmed: 1, evidencePushed: 1 })
    // The failed intent was logged, not fatal.
    expect(log.warn).toHaveBeenCalled()
  })

  it('skips intents with no derivable settlement window (never guesses one)', async () => {
    mocks.findPendingErc7710Settlements.mockResolvedValue([{ ...INTENT, id: 'nowindow', created_at: null }])
    mocks.expectedSettlementTransferFor.mockReturnValue(null)

    const report = await runErc7710SettlementObserver(log)
    expect(report.pending).toBe(1)
    expect(report.confirmed).toBe(0)
    expect(mocks.getProvider).not.toHaveBeenCalled()
  })
})
