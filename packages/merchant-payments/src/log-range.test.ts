/**
 * #4866: `eth_getLogs` windows — the parser mirrors the backend's (#4012), and
 * `scan` narrows on a refusal that names a limit and on nothing else.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOG_SPAN_BLOCKS, LogWindows, parseLogRangeLimit, parseMaxBlockRange } from './log-range.js'

describe('parseLogRangeLimit (#4866)', () => {
  it('reads the public Base Sepolia RPC refusal', () => {
    expect(parseLogRangeLimit({ code: -32614, message: 'eth_getLogs is limited to a 200 range' })).toBe(200)
  })

  it('reads it nested in a viem error cause', () => {
    expect(parseLogRangeLimit({ shortMessage: 'RPC Request failed.', cause: { details: 'eth_getLogs is limited to a 200 range' } })).toBe(200)
  })

  it('reads the other providers the backend knows', () => {
    expect(parseLogRangeLimit(new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range'))).toBe(10)
    expect(parseLogRangeLimit(new Error('exceed maximum block range: 50000'))).toBe(50_000)
    expect(parseLogRangeLimit(new Error('ranges over 10000 blocks are not supported'))).toBe(10_000)
    expect(parseLogRangeLimit(new Error('block range limit (2K) exceeded'))).toBe(2_000)
  })

  it('teaches nothing from a result-size cap or an ordinary failure', () => {
    expect(parseLogRangeLimit(new Error('query returned more than 10000 results'))).toBeNull()
    expect(parseLogRangeLimit(new Error('fetch failed'))).toBeNull()
    expect(parseLogRangeLimit(undefined)).toBeNull()
  })
})

describe('parseMaxBlockRange (#4866)', () => {
  it('takes a positive whole number, and ignores anything else with a warning', () => {
    const warnings: string[] = []
    const warn = (line: string) => warnings.push(line)
    expect(parseMaxBlockRange(undefined, warn)).toBeUndefined()
    expect(parseMaxBlockRange(' 200 ', warn)).toBe(200n)
    expect(parseMaxBlockRange('0', warn)).toBeUndefined()
    expect(parseMaxBlockRange('2k', warn)).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })
})

describe('LogWindows.scan (#4866)', () => {
  const refuseOver = (limit: bigint) => {
    const calls: Array<[bigint, bigint]> = []
    return {
      calls,
      fetch: async (from: bigint, to: bigint) => {
        calls.push([from, to])
        if (to - from + 1n > limit) throw new Error(`eth_getLogs is limited to a ${limit} range`)
        return [from, to] as const
      },
    }
  }

  it('starts at the default 500 and covers the range contiguously', async () => {
    const node = refuseOver(10_000n)
    await new LogWindows().scan(1n, 1_200n, node.fetch)
    expect(DEFAULT_LOG_SPAN_BLOCKS).toBe(500n)
    expect(node.calls).toEqual([
      [1n, 500n],
      [501n, 1_000n],
      [1_001n, 1_200n],
    ])
  })

  it('learns a narrower limit from the refusal and asks the same window again', async () => {
    const node = refuseOver(200n)
    const windows = new LogWindows()
    const results = await windows.scan(1n, 450n, node.fetch)
    expect(node.calls[0]).toEqual([1n, 450n])
    expect(results).toEqual([
      [1n, 200n],
      [201n, 400n],
      [401n, 450n],
    ])
    expect(windows.span()).toBe(200n)
  })

  it('never asks wider than ETH_GETLOGS_MAX_BLOCK_RANGE', async () => {
    const node = refuseOver(10_000n)
    await new LogWindows({ maxSpan: 100n }).scan(1n, 250n, node.fetch)
    expect(node.calls).toEqual([
      [1n, 100n],
      [101n, 200n],
      [201n, 250n],
    ])
  })

  it('throws any other failure unchanged, and a refusal that names no narrower limit', async () => {
    const boom = new Error('fetch failed')
    await expect(new LogWindows().scan(1n, 10n, async () => Promise.reject(boom))).rejects.toBe(boom)
    // Refused at the width it already asks for: nothing narrower to learn.
    await expect(new LogWindows({ maxSpan: 299n }).scan(1n, 10_000n, async (from, to) => {
      throw new Error(`eth_getLogs is limited to a ${to - from + 1n} range`)
    })).rejects.toThrow('limited to a 299 range')
  })

  it('stops early when a window is enough', async () => {
    const node = refuseOver(10_000n)
    const results = await new LogWindows({ maxSpan: 100n }).scan(1n, 1_000n, node.fetch, ([from]) => from === 101n)
    expect(results).toHaveLength(2)
  })
})
