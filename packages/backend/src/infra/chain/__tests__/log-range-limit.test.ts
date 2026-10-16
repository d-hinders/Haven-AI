/**
 * #4012: the provider's `eth_getLogs` range limit — parsed from its refusal,
 * learned per chain, expired, capped by env — and the scanners' rule that a
 * scan the batch budget cut short is "could not ask", never a partial index.
 *
 * The provider is a collaborator this suite does not own, so `getProvider`
 * is mocked. Nothing here touches the database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getLogs = vi.fn()

vi.mock('../relayer-reads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../relayer-reads.js')>()),
  getProvider: () => ({ getLogs }),
}))

vi.mock('../../../rails/delegation-contracts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../rails/delegation-contracts.js')>()),
  getDelegationContracts: () => ({ delegationManager: '0x00000000000000000000000000000000000000dd' }),
}))

import { config } from '../../../config.js'
import {
  effectiveLogBatchBlocks,
  learnedLogRangeLimit,
  LOG_RANGE_LIMIT_TTL_MS,
  noteLogScanFailure,
  parseLogRangeLimit,
  resetLogRangeLimits,
} from '../log-range-limit.js'
import { parseGetLogsMaxBlockRange } from '../../../config.js'
import { findAuthorizationUsedTx, scanAuthorizationUsed } from '../authorization-used-scanner.js'
import { scanRedeemedDelegations } from '../redeemed-delegation-scanner.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const AUTHORIZER = '0x00000000000000000000000000000000000000f1'

/** The refusal Alchemy's free plan returns, in the ethers v6 error shape. */
function alchemyFreeTierError(): Error {
  const err = new Error(
    'could not coalesce error (error={ "code": -32600, "message": "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1, 0xa]. Upgrade to PAYG for expanded block range." }, payload={ ... }, code=UNKNOWN_ERROR, version=6.13.1)',
  ) as Error & { error: unknown }
  err.error = {
    code: -32600,
    message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
  }
  return err
}

const savedCap = config.getLogsMaxBlockRange

beforeEach(() => {
  resetLogRangeLimits()
  getLogs.mockReset()
  config.getLogsMaxBlockRange = null
})

afterEach(() => {
  config.getLogsMaxBlockRange = savedCap
  vi.useRealTimers()
})

describe('parseLogRangeLimit (#4012)', () => {
  it.each([
    ['Alchemy free tier, nested ethers error', alchemyFreeTierError(), 10],
    ['Alchemy PAYG response-size refusal', new Error('Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size'), 2000],
    ['QuickNode, comma-grouped', new Error('eth_getLogs is limited to a 10,000 range'), 10000],
    ['geth-style', new Error('exceed maximum block range: 50000'), 50000],
    ['dRPC', new Error('ranges over 10000 blocks are not supported on freetier'), 10000],
    ['nested under info.error', { message: 'bad', info: { error: { message: 'block range limit (2000) exceeded' } } }, 2000],
  ])('reads the limit from %s', (_name, err, limit) => {
    expect(parseLogRangeLimit(err)).toBe(limit)
  })

  it.each([
    ['a result-size cap is not a range cap', new Error('query returned more than 10000 results')],
    ['an ordinary outage', new Error('ECONNRESET')],
    ['a rate limit', { code: 429, message: 'Your app has exceeded its compute units per second capacity' }],
    ['nothing', undefined],
  ])('learns nothing from %s', (_name, err) => {
    expect(parseLogRangeLimit(err)).toBeNull()
  })
})

describe('the learned limit and the env cap (#4012)', () => {
  it('a refusal narrows that chain only, and expires after the TTL', () => {
    const t0 = 1_000_000
    expect(noteLogScanFailure(CHAIN, alchemyFreeTierError(), t0)).toBe(10)
    expect(effectiveLogBatchBlocks(CHAIN, 500, t0)).toBe(10)
    expect(effectiveLogBatchBlocks(8453, 500, t0)).toBe(500)
    expect(learnedLogRangeLimit(CHAIN, t0 + LOG_RANGE_LIMIT_TTL_MS - 1)).toBe(10)
    // A plan upgrade takes effect without a redeploy: the default is tried again.
    expect(effectiveLogBatchBlocks(CHAIN, 500, t0 + LOG_RANGE_LIMIT_TTL_MS)).toBe(500)
  })

  it('an unparseable failure teaches nothing', () => {
    expect(noteLogScanFailure(CHAIN, new Error('timeout'))).toBeNull()
    expect(effectiveLogBatchBlocks(CHAIN, 500)).toBe(500)
  })

  it('ETH_GETLOGS_MAX_BLOCK_RANGE caps the span with no refusal needed', () => {
    config.getLogsMaxBlockRange = 10
    expect(effectiveLogBatchBlocks(CHAIN, 500)).toBe(10)
    // The default stays a ceiling: a wider cap never widens a request.
    config.getLogsMaxBlockRange = 2000
    expect(effectiveLogBatchBlocks(CHAIN, 500)).toBe(500)
  })

  it.each([
    ['10', 10], [' 2000 ', 2000], [undefined, null], ['', null], ['0', null], ['-5', null], ['1.5', null], ['ten', null],
  ])('parses ETH_GETLOGS_MAX_BLOCK_RANGE=%j as %j', (raw, expected) => {
    expect(parseGetLogsMaxBlockRange(raw as string | undefined)).toBe(expected)
  })
})

describe('the scanners on a refused or truncated scan (#4012)', () => {
  it('a range-limit refusal is still "could not ask", and teaches the chain its limit', async () => {
    getLogs.mockRejectedValue(alchemyFreeTierError())
    const result = await findAuthorizationUsedTx(
      CHAIN, TOKEN, AUTHORIZER, `0x${'00'.repeat(32)}`,
      { fromBlock: 0, toBlock: 499 }, { batchBlocks: 500, maxBatches: 1 },
    )
    expect(result).toEqual({ status: 'unavailable' })
    expect(learnedLogRangeLimit(CHAIN)).toBe(10)
  })

  it('the redemption scanner learns the same way', async () => {
    getLogs.mockRejectedValue(alchemyFreeTierError())
    expect(await scanRedeemedDelegations(CHAIN, { fromBlock: 0, toBlock: 499 }, { batchBlocks: 500, maxBatches: 1 })).toBeNull()
    expect(learnedLogRangeLimit(CHAIN)).toBe(10)
  })

  it('an AuthorizationUsed scan cut short by maxBatches returns null, never a partial index', async () => {
    getLogs.mockResolvedValue([])
    // 3 batches of 10 cover 30 blocks of a 50-block range.
    const index = await scanAuthorizationUsed(CHAIN, TOKEN, AUTHORIZER, { fromBlock: 0, toBlock: 49 }, { batchBlocks: 10, maxBatches: 3 })
    expect(index).toBeNull()
    expect(getLogs).toHaveBeenCalledTimes(3)
  })

  it('a RedeemedDelegation scan cut short by maxBatches returns null, never a partial index', async () => {
    getLogs.mockResolvedValue([])
    expect(await scanRedeemedDelegations(CHAIN, { fromBlock: 0, toBlock: 49 }, { batchBlocks: 10, maxBatches: 3 })).toBeNull()
  })

  it('a scan whose budget covers the whole range is a real (empty) answer', async () => {
    getLogs.mockResolvedValue([])
    const index = await scanAuthorizationUsed(CHAIN, TOKEN, AUTHORIZER, { fromBlock: 0, toBlock: 49 }, { batchBlocks: 10, maxBatches: 5 })
    expect(index).toEqual(new Map())
  })
})
