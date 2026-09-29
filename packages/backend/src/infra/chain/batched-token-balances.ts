/**
 * Batched ERC-20 balance reads for the delegate balance monitor (#3458, epic
 * #3457).
 *
 * The monitor used to await one `balanceOf` `eth_call` per active agent. On
 * dev that was ~1,600 sequential calls per hourly tick — the single largest
 * consumer of the free RPC plan, most of it spent on abandoned QA agents.
 * This reads the same balances through Multicall3 `aggregate3`, CHUNK holders
 * per request, so a scan costs `ceil(N / CHUNK)` requests instead of N.
 *
 * Three choices, each deliberate:
 *
 * - **Sequential chunks, never a burst.** viem's own multicall splits by
 *   calldata bytes (1,024 by default, ~28 `balanceOf` per call) and sends every
 *   chunk at once. At 1,600 holders that is ~57 simultaneous requests — exactly
 *   the burst the #3336 conformance probe finds the free plans rate-limiting
 *   (#3456). Chunking happens here, `batchSize: 0` turns viem's off, and each
 *   chunk is awaited before the next is sent.
 * - **The dedicated endpoint only, no retries.** The monitor is a DETECT
 *   control: a lagging fallback node answering "zero" would be a silent miss,
 *   so no second node may answer (`dedicatedOnly`, as the `disabledDelegations`
 *   reader does). `retryCount: 0` keeps the request count bounded by the chunk
 *   count; a failed chunk is skipped and the next hourly tick reads it again —
 *   the same degradation the per-call loop had for one failed read.
 * - **Per-holder failure, never per-scan.** `allowFailure` isolates a reverted
 *   sub-call to its own holder, and a failed chunk (network, rate limit) marks
 *   only that chunk's holders unread. The caller skips unread holders this
 *   round, exactly as it skipped a failed single read before.
 *
 * A chain whose viem definition carries no Multicall3 falls back to one read
 * per holder, so it is still scanned rather than silently dropped. Every chain
 * served today (100, 8453, 84532) has the canonical deployment in viem's
 * definitions.
 */

import { createPublicClient, erc20Abi, getAddress, isAddress, type Chain, type Transport } from 'viem'
import { chainForId } from '../../rails/delegation-contracts.js'
import { rpcTransport } from './rpc-transport.js'
import { getTokenBalance } from './relayer-reads.js'

/**
 * Holders per `aggregate3` request. A `balanceOf` sub-call is a few thousand
 * gas (one cold storage read plus call overhead) and ~100 bytes of encoded
 * call, so 200 of them is on the order of 1M gas and 20 KB of calldata — the
 * size of one ordinary contract call, well inside what any provider serves
 * for `eth_call` — while still turning 1,600 reads into 8 requests.
 */
export const BALANCE_MULTICALL_CHUNK = 200

export interface BatchedBalanceDeps {
  /** Test seam: the viem chain definition (drives the Multicall3 address). */
  chain?: Chain
  /** Test seam: the transport the client is built on. */
  transport?: Transport
  /** Test seam: the per-holder read used when the chain has no Multicall3. */
  readOne?: (chainId: number, holder: string, token: string) => Promise<bigint>
}

/**
 * Read `token` balances for `holders` on `chainId`. The result maps each
 * holder (as given) to its balance, or to `null` when it could not be read
 * this round. Never throws for a read failure.
 */
export async function readTokenBalances(
  chainId: number,
  token: string,
  holders: string[],
  deps: BatchedBalanceDeps = {},
): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>()
  if (holders.length === 0) return out

  const chain = deps.chain ?? chainForId(chainId)
  if (!chain.contracts?.multicall3?.address) {
    const readOne = deps.readOne ?? getTokenBalance
    for (const holder of holders) {
      try {
        out.set(holder, await readOne(chainId, holder, token))
      } catch {
        out.set(holder, null)
      }
    }
    return out
  }

  const client = createPublicClient({
    chain,
    transport: deps.transport ?? rpcTransport(chainId, { dedicatedOnly: true, retryCount: 0 }),
  })
  const tokenAddress = getAddress(token)

  // A malformed stored address fails alone, before any request is built,
  // instead of taking its whole chunk down with it.
  const readable: string[] = []
  for (const holder of holders) {
    if (isAddress(holder, { strict: false })) readable.push(holder)
    else out.set(holder, null)
  }

  for (let start = 0; start < readable.length; start += BALANCE_MULTICALL_CHUNK) {
    const chunk = readable.slice(start, start + BALANCE_MULTICALL_CHUNK)
    let results: Array<{ status: 'success'; result: bigint } | { status: 'failure' }>
    try {
      results = await client.multicall({
        contracts: chunk.map((holder) => ({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [getAddress(holder)] as const,
        })),
        allowFailure: true,
        batchSize: 0,
      })
    } catch {
      // allowFailure turns a failed request into per-call failures, so this
      // is defence in depth: whatever went wrong, only this chunk is unread.
      for (const holder of chunk) out.set(holder, null)
      continue
    }
    chunk.forEach((holder, i) => {
      const r = results[i]
      out.set(holder, r && r.status === 'success' ? r.result : null)
    })
  }
  return out
}
