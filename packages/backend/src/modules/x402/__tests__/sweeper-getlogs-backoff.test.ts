/**
 * #4012: the settlement sweepers must not re-send a refused `eth_getLogs`
 * every two minutes for a day.
 *
 * On Alchemy's free plan `eth_getLogs` is capped at a 10-block range. Both
 * sweepers asked for 500, the scanners correctly read the refusal as "could
 * not ask", and the eip3009 sweeper deliberately did not back off. So every
 * settled-but-unreported payment burned a receipt read, an `eth_call` and a
 * refused `getLogs` on every tick, 245k compute units an hour on a pool prod
 * shares. These cases pin the four properties of the fix:
 *
 * 1. a failed per-candidate read backs off — nothing is asked about that
 *    candidate on the suppressed tick — and is never a verdict;
 * 2. the backoff grows, is capped, and a success resets it;
 * 3. a range-limit refusal teaches the span, and the next scan fits it;
 * 4. a narrow span costs coverage, never calls: a per-chain budget holds.
 *
 * Database-free on purpose: the candidate query and every chain read are
 * injected, because what is asserted is which RPC calls the tick makes. The
 * database behaviour (what is recorded) is the real-DB suites' job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getLogs = vi.fn()

vi.mock('../../../infra/chain/relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/chain/relayer-reads.js')>()),
  getProvider: () => ({ getLogs }),
}))

import { config } from '../../../config.js'
import { findAuthorizationUsedTx } from '../../../infra/chain/authorization-used-scanner.js'
import {
  learnedLogRangeLimit,
  LOG_RANGE_LIMIT_REASON,
  noteLogScanFailure,
  resetLogRangeLimits,
} from '../../../infra/chain/log-range-limit.js'
import type { SweepableEip3009Row, SweepableSettlementRow } from '../../../infra/repositories/x402-authorizations.js'
import {
  EIP3009_MAX_LOG_CALLS_PER_CHAIN,
  resetEip3009SettlementSweepState,
  runEip3009SettlementSweepTick,
  type Eip3009ChainDeps,
} from '../eip3009-settlement-sweeper.js'
import {
  resetSettlementSweepBackoff,
  runSettlementSweepTick,
  SWEEP_MAX_BATCHES_PER_CHAIN,
  type ChainClock,
} from '../settlement-sweeper.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const DELEGATE = '0x00000000000000000000000000000000000000f1'
const FUNDING_BLOCK = 900_000
const HEAD_BLOCK = 900_400
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)
const MIN = 60_000
/** The head advances with the (fake) clock at Base's ~2s blocks. */
const headNow = () => HEAD_BLOCK + Math.floor((Date.now() - T0) / 2000)

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

function alchemyFreeTierError(): Error {
  const err = new Error('could not coalesce error') as Error & { error: unknown }
  err.error = {
    code: -32600,
    message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
  }
  return err
}

/** A provider that serves at most `limit` blocks per call and refuses wider, as Alchemy's free plan does. */
function providerCappedAt(limit: number) {
  getLogs.mockImplementation(async (filter: { fromBlock: number; toBlock: number }) => {
    if (filter.toBlock - filter.fromBlock + 1 > limit) throw alchemyFreeTierError()
    return []
  })
}

function eip3009Row(n: number): SweepableEip3009Row {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    agent_id: 'agent',
    user_id: 'user',
    chain_id: CHAIN,
    account_address: '0x00000000000000000000000000000000000000a1',
    to_address: DELEGATE,
    token_symbol: 'USDC',
    token_address: TOKEN,
    amount_raw: '100000',
    amount_human: '0.10',
    status: 'confirmed',
    tx_hash: `0x${'d1'.repeat(32)}`,
    created_at: new Date(T0 - 10 * MIN).toISOString(),
    confirmed_at: new Date(T0 - 10 * MIN).toISOString(),
  } as SweepableEip3009Row
}

/** Every read the eip3009 tick makes, counted; `authorizationState` is true (settled-but-unreported). */
function eip3009Chain(findUsed: Eip3009ChainDeps['findUsed']) {
  const calls = { head: 0, receipt: 0, state: 0 }
  const chain: Partial<Eip3009ChainDeps> = {
    readHead: async () => { calls.head += 1; return headNow() },
    readFundingBlock: async () => { calls.receipt += 1; return FUNDING_BLOCK },
    readAuthState: async () => { calls.state += 1; return true },
    findUsed,
  }
  return { chain, calls }
}

const savedCap = config.getLogsMaxBlockRange

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  resetEip3009SettlementSweepState()
  resetSettlementSweepBackoff()
  resetLogRangeLimits()
  getLogs.mockReset()
  log.debug.mockReset(); log.info.mockReset(); log.warn.mockReset()
  config.getLogsMaxBlockRange = null
})

afterEach(() => {
  config.getLogsMaxBlockRange = savedCap
  vi.useRealTimers()
})

describe('eip3009 sweeper — a failed scan backs off (#4012)', () => {
  it('a scan that fails on every getLogs is backed off: the next tick asks NOTHING about that candidate', async () => {
    const row = eip3009Row(1)
    getLogs.mockRejectedValue(new Error('ECONNRESET'))
    const { chain, calls } = eip3009Chain(findAuthorizationUsedTx)
    const findCandidates = async () => [row]

    const first = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(first).toMatchObject({ candidates: 1, chainsUnavailable: 1, recorded: 0, unresolved: 0 })
    expect(getLogs).toHaveBeenCalledTimes(1)

    // The very next tick (the sweeper runs every 2 min; 1 min here so the
    // base delay has not run out): no receipt, no eth_call, no getLogs.
    vi.setSystemTime(T0 + 1 * MIN)
    getLogs.mockClear()
    const before = { ...calls }
    const second = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(second).toMatchObject({ candidates: 1, suppressed: 1, chainsUnavailable: 0 })
    expect(getLogs).not.toHaveBeenCalled()
    expect(calls.receipt).toBe(before.receipt)
    expect(calls.state).toBe(before.state)
  })

  it('the delay grows, is capped at an hour, and is never a fruitless verdict', async () => {
    const row = eip3009Row(1)
    const findUsed = vi.fn(async () => ({ status: 'unavailable' as const }))
    const { chain } = eip3009Chain(findUsed)
    const findCandidates = async () => [row]

    // Attempt times under a doubling 2-min schedule: 0, +2, +4, +8, +16, +32, then +60 (capped), +60.
    const gaps = [2, 4, 8, 16, 32, 60, 60]
    let now = T0
    await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    for (const gap of gaps) {
      vi.setSystemTime(now + gap * MIN - 1)
      await runEip3009SettlementSweepTick(log, { findCandidates, chain })
      const calledBefore = findUsed.mock.calls.length
      vi.setSystemTime(now + gap * MIN)
      await runEip3009SettlementSweepTick(log, { findCandidates, chain })
      expect(findUsed.mock.calls.length).toBe(calledBefore + 1)
      now += gap * MIN
    }
    expect(findUsed).toHaveBeenCalledTimes(1 + gaps.length)
    // Every attempt asked from the funding block: a failure never moves the cursor.
    for (const call of findUsed.mock.calls as unknown as Array<[number, string, string, string, { fromBlock: number }]>) {
      expect(call[4].fromBlock).toBe(FUNDING_BLOCK)
    }
    // "Could not ask" never reaches the unresolved alert.
    expect(log.warn).not.toHaveBeenCalledWith(expect.objectContaining({ reason: 'no_matching_authorization_used' }), expect.any(String))
  })

  it('a successful read resets the failure backoff: the next failure starts at the base delay again', async () => {
    const row = eip3009Row(1)
    const outcomes: Array<'unavailable' | 'none'> = ['unavailable', 'unavailable', 'none', 'unavailable']
    const findUsed = vi.fn(async () => ({ status: outcomes.shift() ?? ('none' as const) }))
    const { chain } = eip3009Chain(findUsed)
    const findCandidates = async () => [row]

    await runEip3009SettlementSweepTick(log, { findCandidates, chain }) // fail #1 → +2 min
    vi.setSystemTime(T0 + 2 * MIN)
    await runEip3009SettlementSweepTick(log, { findCandidates, chain }) // fail #2 → +4 min
    vi.setSystemTime(T0 + 6 * MIN)
    await runEip3009SettlementSweepTick(log, { findCandidates, chain }) // success → fruitless +2 min
    vi.setSystemTime(T0 + 8 * MIN)
    await runEip3009SettlementSweepTick(log, { findCandidates, chain }) // fail again
    expect(findUsed).toHaveBeenCalledTimes(4)

    // Base delay (2 min), not the 8 min a carried-over third failure would
    // get: the candidate is asked again at +10 min.
    vi.setSystemTime(T0 + 10 * MIN)
    const result = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(result.suppressed).toBe(0)
    expect(findUsed).toHaveBeenCalledTimes(5)
  })

  it('an unreadable funding receipt or authorizationState backs off too, judging nothing', async () => {
    const rows = [eip3009Row(1), eip3009Row(2)]
    let receiptReads = 0
    let stateReads = 0
    const chain: Partial<Eip3009ChainDeps> = {
      readHead: async () => HEAD_BLOCK,
      readFundingBlock: async (_c, _h) => { receiptReads += 1; return receiptReads === 1 ? null : FUNDING_BLOCK },
      readAuthState: async () => { stateReads += 1; return null },
      findUsed: vi.fn(),
    }
    const findCandidates = async () => rows

    const first = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(first.chainsUnavailable).toBe(2)
    vi.setSystemTime(T0 + 1 * MIN)
    const second = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(second.suppressed).toBe(2)
    expect(receiptReads).toBe(2)
    expect(stateReads).toBe(1)
  })

  it('an unreadable chain head is chain-wide and costs one read, so it is NOT backed off', async () => {
    const row = eip3009Row(1)
    const readHead = vi.fn(async () => null)
    const chain: Partial<Eip3009ChainDeps> = { readHead, readFundingBlock: vi.fn(), readAuthState: vi.fn(), findUsed: vi.fn() }
    await runEip3009SettlementSweepTick(log, { findCandidates: async () => [row], chain })
    vi.setSystemTime(T0 + 1 * MIN)
    const second = await runEip3009SettlementSweepTick(log, { findCandidates: async () => [row], chain })
    expect(second.suppressed).toBe(0)
    expect(readHead).toHaveBeenCalledTimes(2)
  })
})

describe('eip3009 sweeper — the span adapts to the provider (#4012)', () => {
  it('a range-limit refusal is named at warn, narrows the span, and the next scan fits the provider', async () => {
    providerCappedAt(10)
    const row = eip3009Row(1)
    const { chain } = eip3009Chain(findAuthorizationUsedTx)
    const findCandidates = async () => [row]

    const first = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(first.chainsUnavailable).toBe(1)
    expect(learnedLogRangeLimit(CHAIN)).toBe(10)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: CHAIN, reason: LOG_RANGE_LIMIT_REASON, requestedBlocks: 500, limitBlocks: 10 }),
      expect.any(String),
    )

    // Not backed off: the next request is a different, fitting one.
    getLogs.mockClear()
    vi.setSystemTime(T0 + 2 * MIN)
    const second = await runEip3009SettlementSweepTick(log, { findCandidates, chain })
    expect(second.chainsUnavailable).toBe(0)
    expect(getLogs).toHaveBeenCalled()
    for (const [filter] of getLogs.mock.calls as Array<[{ fromBlock: number; toBlock: number }]>) {
      expect(filter.toBlock - filter.fromBlock + 1).toBeLessThanOrEqual(10)
    }
    // 20 calls × 10 blocks: the cursor covers 200 blocks this tick, not 10,000 in 1,000 calls.
    expect(getLogs).toHaveBeenCalledTimes(20)
  })

  it('ETH_GETLOGS_MAX_BLOCK_RANGE fits the span before any refusal', async () => {
    config.getLogsMaxBlockRange = 10
    providerCappedAt(10)
    const { chain } = eip3009Chain(findAuthorizationUsedTx)
    const result = await runEip3009SettlementSweepTick(log, { findCandidates: async () => [eip3009Row(1)], chain })
    expect(result.chainsUnavailable).toBe(0)
    expect(log.warn).not.toHaveBeenCalledWith(expect.objectContaining({ reason: LOG_RANGE_LIMIT_REASON }), expect.any(String))
  })

  it('a narrow span costs coverage, never calls: a backlog stays inside the per-chain call budget', async () => {
    noteLogScanFailure(CHAIN, alchemyFreeTierError(), T0)
    providerCappedAt(10)
    const rows = Array.from({ length: 105 }, (_, i) => eip3009Row(i + 1))
    const { chain } = eip3009Chain(findAuthorizationUsedTx)

    const result = await runEip3009SettlementSweepTick(log, { findCandidates: async () => rows, chain })
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(EIP3009_MAX_LOG_CALLS_PER_CHAIN)
    // The ones the budget did not reach are untouched, not judged and not backed off.
    expect(result.suppressed).toBe(104)
    expect(result.unresolved).toBe(0)

    // While the first candidate's fruitless backoff holds, the budget moves on
    // to the next one (whose scan starts at its own funding block) instead of
    // starving it.
    getLogs.mockClear()
    vi.setSystemTime(T0 + 1 * MIN)
    const second = await runEip3009SettlementSweepTick(log, { findCandidates: async () => rows, chain })
    expect(getLogs.mock.calls.length).toBe(EIP3009_MAX_LOG_CALLS_PER_CHAIN)
    expect((getLogs.mock.calls[0] as [{ fromBlock: number }])[0].fromBlock).toBe(FUNDING_BLOCK)
    expect(second.suppressed).toBe(104)
  })
})

// ── erc7710 ────────────────────────────────────────────────────────────────

const CLOCK: ChainClock = { headNumber: 2_000_000, headTimestamp: Math.floor(T0 / 1000), secondsPerBlock: 2 }

function erc7710Row(n: number): SweepableSettlementRow {
  return {
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    agent_id: 'agent',
    chain_id: CHAIN,
    account_address: '0x00000000000000000000000000000000000000a1',
    to_address: '0x00000000000000000000000000000000000000aa',
    token_symbol: 'USDC',
    token_address: TOKEN,
    amount_raw: '100000',
    amount_human: '0.10',
    status: 'submitted',
    tx_hash: null,
    delegation_hash: `0x${'ab'.repeat(32)}`,
    created_at: new Date(T0 - 5 * MIN).toISOString(),
    source: 'x402',
    payment_rail: 'x402',
    execution_rail: 'delegation',
  } as SweepableSettlementRow
}

function erc7710Deps(scan: Parameters<typeof runSettlementSweepTick>[1] extends infer D ? D extends { scan?: infer S } ? S : never : never, rows: SweepableSettlementRow[]) {
  return {
    findCandidates: async () => rows,
    findOrphans: async () => [],
    readClock: async () => CLOCK,
    scan,
    observe: vi.fn(),
    recordEvidence: vi.fn(),
  }
}

describe('erc7710 sweeper — a failed scan backs off (#4012)', () => {
  it('a scan that fails every time is backed off: the next tick makes no scan call', async () => {
    const scan = vi.fn(async () => null)
    const deps = erc7710Deps(scan, [erc7710Row(1), erc7710Row(2)])

    const first = await runSettlementSweepTick(log, deps)
    expect(first.chainsUnavailable).toBe(1)
    expect(scan).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T0 + 1 * MIN)
    const second = await runSettlementSweepTick(log, deps)
    expect(second.suppressed).toBe(2)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('a range-limit refusal is named at warn and NOT backed off; the next tick asks with the narrowed span', async () => {
    const scan = vi.fn(async (chainId: number) => {
      noteLogScanFailure(chainId, alchemyFreeTierError())
      return null
    })
    const deps = erc7710Deps(scan, [erc7710Row(1)])
    await runSettlementSweepTick(log, deps)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: CHAIN, reason: LOG_RANGE_LIMIT_REASON, requestedBlocks: 500, limitBlocks: 10 }),
      expect.any(String),
    )
    // Not suppressed by a backoff next tick — instead, at a 10-block span the
    // window cannot fit the call budget, so it is skipped without a scan.
    vi.setSystemTime(T0 + 2 * MIN)
    const second = await runSettlementSweepTick(log, deps)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(second.suppressed).toBe(1)
  })

  it('a window too wide for the call budget at the provider span is not walked: no scan, backed off, cause named', async () => {
    config.getLogsMaxBlockRange = 10
    const scan = vi.fn(async () => new Map())
    const deps = erc7710Deps(scan, [erc7710Row(1)])

    const first = await runSettlementSweepTick(log, deps)
    expect(scan).not.toHaveBeenCalled()
    expect(first.suppressed).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: LOG_RANGE_LIMIT_REASON, batchBlocks: 10, maxBatches: SWEEP_MAX_BATCHES_PER_CHAIN }),
      expect.any(String),
    )

    // Backed off: the next tick does not even read the chain clock for it.
    const readClock = vi.fn(async () => CLOCK)
    vi.setSystemTime(T0 + 1 * MIN)
    await runSettlementSweepTick(log, { ...deps, readClock })
    expect(readClock).not.toHaveBeenCalled()
  })

  it('the span the scanner is asked for is the provider span, and the call count fits it', async () => {
    config.getLogsMaxBlockRange = 200
    const scan = vi.fn(async () => new Map())
    await runSettlementSweepTick(log, erc7710Deps(scan, [erc7710Row(1)]))
    expect(scan).toHaveBeenCalledTimes(1)
    const [, range, options] = scan.mock.calls[0] as unknown as [number, { fromBlock: number; toBlock: number }, { batchBlocks: number; maxBatches: number }]
    expect(options.batchBlocks).toBe(200)
    expect(options.maxBatches * options.batchBlocks).toBeGreaterThanOrEqual(range.toBlock - range.fromBlock + 1)
    expect(options.maxBatches).toBeLessThanOrEqual(SWEEP_MAX_BATCHES_PER_CHAIN)
  })
})
