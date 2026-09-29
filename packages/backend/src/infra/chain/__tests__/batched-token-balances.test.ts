/**
 * #3458 (epic #3457): the delegate balance monitor's batched reader.
 *
 * Driven through a REAL viem public client over a `custom` transport that
 * plays the node: it decodes each `aggregate3` request, answers every
 * `balanceOf` from a table, and records how many JSON-RPC requests arrived
 * and how many were in flight at once. So the counts below are what viem put
 * on the wire, not what a mocked `multicall` was asked to do — a viem-side
 * re-split (its default 1,024-byte `batchSize`) or a parallel fan-out would
 * show up here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  multicall3Abi,
  type Chain,
  type Hex,
} from 'viem'
import { baseSepolia } from 'viem/chains'

const { rpcTransportCalls } = vi.hoisted(() => ({ rpcTransportCalls: [] as unknown[][] }))
vi.mock('../rpc-transport.js', () => ({
  rpcTransport: (...args: unknown[]) => {
    rpcTransportCalls.push(args)
    throw new Error('the test must inject its own transport')
  },
}))
vi.mock('../relayer-reads.js', () => ({
  getTokenBalance: () => {
    throw new Error('the test must inject its own per-holder read')
  },
}))

const { BALANCE_MULTICALL_CHUNK, readTokenBalances } = await import('../batched-token-balances.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function holder(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`
}

interface FakeNode {
  transport: ReturnType<typeof custom>
  stats: { requests: number; ethCalls: number; peakInFlight: number }
}

/**
 * A node that answers `aggregate3` of `balanceOf` calls. `balances` keys are
 * checksummed holders; a holder in `revert` fails its sub-call; a request
 * whose index is in `failRequests` fails as a whole (a rate limit, say).
 */
function fakeNode(opts: {
  balances: (addr: string) => bigint
  revert?: Set<string>
  failRequests?: Set<number>
}): FakeNode {
  const stats = { requests: 0, ethCalls: 0, peakInFlight: 0 }
  let inFlight = 0
  // retryCount 0 mirrors the production transport (asserted separately below),
  // so a failed request is counted once rather than re-sent by viem.
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      stats.requests += 1
      if (method === 'eth_chainId') return `0x${baseSepolia.id.toString(16)}`
      if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
      const callIndex = stats.ethCalls
      stats.ethCalls += 1
      inFlight += 1
      stats.peakInFlight = Math.max(stats.peakInFlight, inFlight)
      try {
        // Yield so a parallel fan-out would overlap and raise the peak.
        await new Promise((r) => setTimeout(r, 5))
        if (opts.failRequests?.has(callIndex)) throw new Error('429 Too Many Requests')
        const [{ data, to }] = params as [{ data: Hex; to: string }]
        if (getAddress(to) !== getAddress(baseSepolia.contracts.multicall3.address)) {
          throw new Error(`eth_call to ${to}, not Multicall3`)
        }
        const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data })
        if (functionName !== 'aggregate3') throw new Error(`unexpected ${functionName}`)
        const calls = args[0] as ReadonlyArray<{ target: string; callData: Hex }>
        const results = calls.map(({ target, callData }) => {
          if (getAddress(target) !== getAddress(USDC)) throw new Error(`sub-call to ${target}, not the token`)
          const decoded = decodeFunctionData({ abi: erc20Abi, data: callData })
          const who = getAddress(decoded.args![0] as string)
          if (opts.revert?.has(who)) return { success: false, returnData: '0x' as Hex }
          return {
            success: true,
            returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: opts.balances(who) }),
          }
        })
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
      } finally {
        inFlight -= 1
      }
    },
  }, { retryCount: 0 })
  return { transport, stats }
}

const balanceOf = (addr: string) => BigInt(parseInt(addr.slice(-6), 16)) * 1000n

describe('readTokenBalances — batched, sequential, per-holder failure (#3458)', () => {
  it('1,600 holders cost ceil(1600 / CHUNK) requests, not 1,600, and every balance is right', async () => {
    const holders = Array.from({ length: 1600 }, (_, i) => holder(i + 1))
    const node = fakeNode({ balances: balanceOf })

    const out = await readTokenBalances(baseSepolia.id, USDC, holders, { chain: baseSepolia, transport: node.transport })

    expect(node.stats.ethCalls).toBe(Math.ceil(1600 / BALANCE_MULTICALL_CHUNK))
    // Every JSON-RPC request, not just eth_call, stays inside the bound.
    expect(node.stats.requests).toBeLessThanOrEqual(Math.ceil(1600 / BALANCE_MULTICALL_CHUNK))
    expect(out.size).toBe(1600)
    for (const h of holders) expect(out.get(h)).toBe(balanceOf(getAddress(h)))
  })

  it('never has more than one balance request in flight — no burst', async () => {
    const holders = Array.from({ length: 1600 }, (_, i) => holder(i + 1))
    const node = fakeNode({ balances: balanceOf })

    await readTokenBalances(baseSepolia.id, USDC, holders, { chain: baseSepolia, transport: node.transport })

    expect(node.stats.ethCalls).toBeGreaterThan(1) // the bound below is not vacuous
    expect(node.stats.peakInFlight).toBe(1)
  })

  it('a reverted sub-call leaves only THAT holder unread', async () => {
    const holders = [holder(1), holder(2), holder(3)]
    const node = fakeNode({ balances: balanceOf, revert: new Set([getAddress(holder(2))]) })

    const out = await readTokenBalances(baseSepolia.id, USDC, holders, { chain: baseSepolia, transport: node.transport })

    expect(out.get(holder(1))).toBe(balanceOf(getAddress(holder(1))))
    expect(out.get(holder(2))).toBeNull()
    expect(out.get(holder(3))).toBe(balanceOf(getAddress(holder(3))))
  })

  it('a failed request leaves only ITS chunk unread and the scan carries on', async () => {
    const n = BALANCE_MULTICALL_CHUNK * 2 + 5
    const holders = Array.from({ length: n }, (_, i) => holder(i + 1))
    const node = fakeNode({ balances: balanceOf, failRequests: new Set([1]) }) // the second chunk

    const out = await readTokenBalances(baseSepolia.id, USDC, holders, { chain: baseSepolia, transport: node.transport })

    expect(node.stats.ethCalls).toBe(3) // no retry: the failed chunk is not re-sent
    const unread = holders.filter((h) => out.get(h) === null)
    expect(unread).toEqual(holders.slice(BALANCE_MULTICALL_CHUNK, BALANCE_MULTICALL_CHUNK * 2))
    expect(out.get(holders[0])).toBe(balanceOf(getAddress(holders[0])))
    expect(out.get(holders[n - 1])).toBe(balanceOf(getAddress(holders[n - 1])))
  })

  it('a malformed stored address fails alone, before any request', async () => {
    const holders = [holder(1), 'not-an-address', holder(2)]
    const node = fakeNode({ balances: balanceOf })

    const out = await readTokenBalances(baseSepolia.id, USDC, holders, { chain: baseSepolia, transport: node.transport })

    expect(out.get('not-an-address')).toBeNull()
    expect(out.get(holder(1))).toBe(balanceOf(getAddress(holder(1))))
    expect(out.get(holder(2))).toBe(balanceOf(getAddress(holder(2))))
    expect(node.stats.ethCalls).toBe(1)
  })

  it('a chain with no Multicall3 falls back to one read per holder — scanned, not dropped', async () => {
    const noMulticall = { ...baseSepolia, contracts: {} } as unknown as Chain
    const readOne = vi.fn(async (_c: number, h: string) => {
      if (h === holder(2)) throw new Error('rpc hiccup')
      return balanceOf(getAddress(h))
    })
    const node = fakeNode({ balances: balanceOf })

    const out = await readTokenBalances(baseSepolia.id, USDC, [holder(1), holder(2)], {
      chain: noMulticall,
      transport: node.transport,
      readOne,
    })

    expect(readOne).toHaveBeenCalledTimes(2)
    expect(node.stats.requests).toBe(0)
    expect(out.get(holder(1))).toBe(balanceOf(getAddress(holder(1))))
    expect(out.get(holder(2))).toBeNull()
  })

  it('production transport: the dedicated endpoint only, with no retries (a DETECT read no fallback may answer)', async () => {
    rpcTransportCalls.length = 0
    await expect(readTokenBalances(baseSepolia.id, USDC, [holder(1)], { chain: baseSepolia })).rejects.toThrow(
      'the test must inject its own transport',
    )
    expect(rpcTransportCalls).toEqual([[baseSepolia.id, { dedicatedOnly: true, retryCount: 0 }]])
  })

  it('no holders, no requests', async () => {
    const node = fakeNode({ balances: balanceOf })
    const out = await readTokenBalances(baseSepolia.id, USDC, [], { chain: baseSepolia, transport: node.transport })
    expect(out.size).toBe(0)
    expect(node.stats.requests).toBe(0)
  })

  it('every chain Haven serves has Multicall3 in its viem definition (the fallback is for a future chain)', async () => {
    const { chainForId } = await import('../../../rails/delegation-contracts.js')
    const { SUPPORTED_CHAIN_IDS } = await import('../../../domain/chains.js')
    expect(SUPPORTED_CHAIN_IDS.length).toBeGreaterThan(0)
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(chainForId(id).contracts?.multicall3?.address, `chain ${id}`).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('a chain viem does not know falls back to one read per holder — scanned, not dropped', async () => {
    const readOne = vi.fn(async (_c: number, h: string) => balanceOf(getAddress(h)))
    const out = await readTokenBalances(999_999, USDC, [holder(1), holder(2)], { readOne })
    expect(readOne).toHaveBeenCalledTimes(2)
    expect(out.get(holder(2))).toBe(balanceOf(getAddress(holder(2))))
  })

  it('a delegate address listed twice is read once', async () => {
    const node = fakeNode({ balances: balanceOf })
    const readOne = vi.fn(async (_c: number, h: string) => balanceOf(getAddress(h)))
    const noMulticall = { ...baseSepolia, contracts: {} } as unknown as Chain
    await readTokenBalances(baseSepolia.id, USDC, [holder(1), holder(1), holder(2)], { chain: noMulticall, readOne })
    expect(readOne).toHaveBeenCalledTimes(2)
    const out = await readTokenBalances(baseSepolia.id, USDC, [holder(1), holder(1)], { chain: baseSepolia, transport: node.transport })
    expect(out.get(holder(1))).toBe(balanceOf(getAddress(holder(1))))
  })

  it('refuses a zero/native token instead of reading it two different ways', async () => {
    await expect(
      readTokenBalances(baseSepolia.id, '0x0000000000000000000000000000000000000000', [holder(1)], { chain: baseSepolia }),
    ).rejects.toThrow(/ERC-20/)
  })
})
