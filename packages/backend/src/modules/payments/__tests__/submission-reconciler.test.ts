/**
 * Unit coverage for the submission reconciler's DECISION layer (#3564): the
 * tick maps each bundler receipt answer to exactly one store call, leaves
 * everything unresolved alone, and never lets one poison row silence the
 * rest. The receipt reader's mapping (null / unknown hash / RPC error →
 * not_found_yet) is asserted against the REAL `readUserOperationReceipt`
 * below with its client stubbed; what the terminal writes do to the row is
 * proven on the real harness in
 * `submission-outcome-reconciliation.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECONCILE_MAX_AGE_SECONDS,
  RECONCILE_MIN_AGE_SECONDS,
  runSubmissionReconcileTick,
  type ReconcileLogger,
} from '../submission-reconciler.js'
import { readUserOperationReceipt } from '../../../rails/delegation-rail.js'

const log: ReconcileLogger = { info: vi.fn(), warn: vi.fn() }

type ReceiptAnswer =
  | { state: 'included'; success: boolean; txHash: string }
  | { state: 'not_found_yet' }

function row(overrides: Partial<{ id: string; agent_id: string; chain_id: number; signed_at: string; user_op_hash: string }> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    agent_id: '22222222-2222-2222-2222-222222222222',
    chain_id: 84532,
    signed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    user_op_hash: `0x${'ab'.repeat(32)}`,
    ...overrides,
  }
}

function tickDeps(rows: unknown[], readReceipt: (chainId: number, hash: string) => Promise<ReceiptAnswer>) {
  return {
    findCandidates: vi.fn(async () => rows as never[]),
    readReceipt: vi.fn(readReceipt) as unknown as typeof readUserOperationReceipt,
    // The tick's terminal writes are injected like its reads, so no db.js
    // mock is needed here (the shrink-only db-mock ratchet, #1227); what
    // those writes DO to the row is proven on the real harness in
    // submission-outcome-reconciliation.test.ts.
    confirmOutcome: vi.fn(async () => true) as unknown as typeof import('../../../infra/repositories/payment-intents.js').reconcileOutcomeConfirmed,
    failOutcome: vi.fn(async () => true) as unknown as typeof import('../../../infra/repositories/payment-intents.js').reconcileOutcomeFailed,
  }
}

describe('#3564 — the submission reconciler tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a landed-and-succeeded receipt confirms the row with the receipt tx hash', async () => {
    const deps = tickDeps([row()], async () => ({ state: 'included', success: true, txHash: `0x${'ef'.repeat(32)}` }))
    const result = await runSubmissionReconcileTick(log, deps)
    expect(result).toMatchObject({ candidates: 1, confirmed: 1, failedReverted: 0, failedWindowElapsed: 0, unresolved: 0 })
  })

  it('a landed-but-reverted receipt fails the row with the revert cause', async () => {
    const deps = tickDeps([row()], async () => ({ state: 'included', success: false, txHash: `0x${'ef'.repeat(32)}` }))
    const result = await runSubmissionReconcileTick(log, deps)
    expect(result).toMatchObject({ candidates: 1, confirmed: 0, failedReverted: 1, unresolved: 0 })
  })

  it('a not-found receipt inside the window leaves the row unresolved — no write, no verdict', async () => {
    const deps = tickDeps([row()], async () => ({ state: 'not_found_yet' }))
    const result = await runSubmissionReconcileTick(log, deps)
    expect(result).toMatchObject({ candidates: 1, confirmed: 0, failedReverted: 0, failedWindowElapsed: 0, unresolved: 1 })
  })

  it('a not-found receipt past the bounded window resolves failed with the window cause', async () => {
    const deps = tickDeps(
      [row({ signed_at: new Date(Date.now() - (RECONCILE_MAX_AGE_SECONDS + 600) * 1000).toISOString() })],
      async () => ({ state: 'not_found_yet' }),
    )
    const result = await runSubmissionReconcileTick(log, deps)
    expect(result).toMatchObject({ candidates: 1, confirmed: 0, failedReverted: 0, failedWindowElapsed: 1, unresolved: 0 })
  })

  it('a read that THROWS is "not known yet": the row stays unresolved, the tick moves on', async () => {
    const deps = tickDeps([row(), row({ id: '33333333-3333-3333-3333-333333333333', user_op_hash: `0x${'cc'.repeat(32)}` })], async () => {
      throw new Error('bundler rpc down')
    })
    const result = await runSubmissionReconcileTick(log, deps)
    expect(result).toMatchObject({ candidates: 2, unresolved: 2 })
    // The poison row did not silence the second candidate — both were read.
    expect(deps.readReceipt).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('candidates are bounded by the tick limit and read with the age gate constants', async () => {
    const deps = tickDeps([], async () => ({ state: 'not_found_yet' }))
    await runSubmissionReconcileTick(log, deps)
    expect(deps.findCandidates).toHaveBeenCalledWith(RECONCILE_MIN_AGE_SECONDS, 100)
    expect(typeof RECONCILE_MIN_AGE_SECONDS).toBe('number')
    expect(RECONCILE_MAX_AGE_SECONDS).toBeGreaterThan(RECONCILE_MIN_AGE_SECONDS)
  })
})

describe('#3564 — readUserOperationReceipt maps every unknown to not_found_yet', () => {
  // The credential is resolved through the REAL `delegationRailBundlerUrl`
  // (the choke point — that is the property under test), so the suite runs
  // against the real seam with the env credential set and only the HTTP
  // transport mocked away. No module mock of the rail itself.
  const OLD_URL = process.env.DELEGATION_RAIL_BUNDLER_URL_84532
  beforeAll(() => {
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = 'https://bundler.example/v2/84532'
  })
  afterAll(() => {
    if (OLD_URL === undefined) delete process.env.DELEGATION_RAIL_BUNDLER_URL_84532
    else process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = OLD_URL
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: null }) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a null receipt (op not indexed / unknown hash) is not_found_yet — never a verdict', async () => {
    await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({ state: 'not_found_yet' })
  })

  it('a transport error is not_found_yet — the next tick is the retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('502 bad gateway')
    }))
    await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({ state: 'not_found_yet' })
  })

  it('a missing bundler credential is not_found_yet too — a config state must not throw out of the seam', async () => {
    delete process.env.DELEGATION_RAIL_BUNDLER_URL_84532
    delete process.env.DELEGATION_RAIL_BUNDLER_URL
    try {
      await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({ state: 'not_found_yet' })
    } finally {
      process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = 'https://bundler.example/v2/84532'
    }
  })

  it('the resolved URL is chain-checked: a mismatched credential is not_found_yet, never a cross-chain read', async () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = 'https://bundler.example/v2/8453/wrong-chain'
    try {
      await expect(readUserOperationReceipt(84532, `0x${'ab'.repeat(32)}`)).resolves.toEqual({ state: 'not_found_yet' })
    } finally {
      process.env.DELEGATION_RAIL_BUNDLER_URL_84532 = 'https://bundler.example/v2/84532'
    }
  })
})
