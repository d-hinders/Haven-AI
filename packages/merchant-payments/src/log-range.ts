/**
 * #4866: `eth_getLogs` in windows the RPC provider will serve.
 *
 * The public Base Sepolia RPC (`https://sepolia.base.org`) answers
 * `eth_getLogs` for at most 200 blocks and refuses a wider range with
 * "eth_getLogs is limited to a 200 range" (-32614). Two readers in the
 * demo merchant ask for more: the reconciliation script (one call over the whole
 * range) and #4851's recovery search (500-block chunks).
 *
 * This mirrors the backend's answer to the same problem (#4012,
 * `packages/backend/src/infra/chain/log-range-limit.ts`): the window is the
 * minimum of
 *
 * 1. the reader's own default (500 blocks);
 * 2. `ETH_GETLOGS_MAX_BLOCK_RANGE`, when the operator knows the plan;
 * 3. the limit the provider named in its last refusal.
 *
 * The third is learned, so the code works on any plan without configuration,
 * and Base mainnet keeps its current behaviour unless its provider refuses.
 * A learned limit lives as long as the process: the merchant sleeps after
 * about 10 minutes, and the reconciliation script is a one-off.
 *
 * Spans count blocks INCLUSIVELY, as the backend does: a 200-block window is
 * `[start, start + 199]`.
 *
 * This is the shared copy for the merchant side (the demo merchant and the
 * paywall proxy, #4890). The backend keeps its own parser: the two are
 * separate on purpose, and the pattern list above is the one thing they must
 * keep in step.
 *
 * It never turns a refusal into an answer. A refusal that names a narrower
 * limit is retried once at that width; any other failure is thrown unchanged,
 * and the caller decides what an unavailable read means.
 */

/** The window a reader asks for before any limit is known. */
export const DEFAULT_LOG_SPAN_BLOCKS = 500n

/**
 * The range-limit phrasings providers return, each capturing the number and
 * an optional `K`. The same set as the backend's `RANGE_LIMIT_PATTERNS`
 * (#4012), so the two cannot disagree about what a refusal says. Anchored on
 * "block range" wording, so a result-size cap is not mistaken for a range cap.
 */
const RANGE_LIMIT_PATTERNS: RegExp[] = [
  // Alchemy: "…with up to a 10 block range", "…up to a 2K block range…"
  /up to an? ([\d,]+)\s*(k)?\s*block range/i,
  // geth-style and several hosted nodes: "exceed maximum block range: 50000"
  /maximum block range(?: is| of|:)?\s*([\d,]+)\s*(k)?/i,
  // QuickNode and the public Base Sepolia RPC: "eth_getLogs is limited to a 200 range"
  /limited to an? ([\d,]+)\s*(k)?\s*(?:block )?range/i,
  // dRPC: "ranges over 10000 blocks are not supported"
  /ranges? over ([\d,]+)\s*(k)?\s*blocks/i,
  // "block range limit (2000) exceeded", "block range limit: 2000"
  /block range limit\s*[(:]?\s*([\d,]+)\s*(k)?/i,
]

function messagesOf(err: unknown, depth = 0): string[] {
  if (err === null || err === undefined || depth > 3) return []
  if (typeof err === 'string') return [err]
  if (typeof err !== 'object') return []
  const e = err as Record<string, unknown>
  const out: string[] = []
  for (const key of ['message', 'shortMessage', 'details']) {
    if (typeof e[key] === 'string') out.push(e[key] as string)
  }
  out.push(...messagesOf(e.error, depth + 1))
  out.push(...messagesOf(e.cause, depth + 1))
  return out
}

/**
 * The block-range cap a provider's `eth_getLogs` refusal names, or `null` when
 * the error is not a range refusal or names no usable number.
 */
export function parseLogRangeLimit(err: unknown): number | null {
  for (const message of messagesOf(err)) {
    for (const pattern of RANGE_LIMIT_PATTERNS) {
      const match = pattern.exec(message)
      if (!match) continue
      const base = Number(match[1]!.replace(/,/g, ''))
      const limit = match[2] ? base * 1000 : base
      if (Number.isInteger(limit) && limit > 0) return limit
    }
  }
  return null
}

/**
 * `ETH_GETLOGS_MAX_BLOCK_RANGE`, parsed. A positive whole number, or
 * `undefined` when unset. A value that is not one is ignored with a warning
 * that names the variable, never its value's surroundings.
 */
export function parseMaxBlockRange(
  raw: string | undefined,
  warn: (message: string) => void = console.warn,
): bigint | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) {
    warn('ETH_GETLOGS_MAX_BLOCK_RANGE is not a positive whole number; it is ignored and the default window is used.')
    return undefined
  }
  return BigInt(value)
}

export interface LogWindowsOptions {
  /** The reader's own default. `DEFAULT_LOG_SPAN_BLOCKS` when absent. */
  defaultSpan?: bigint
  /** `ETH_GETLOGS_MAX_BLOCK_RANGE`, when the operator set it. */
  maxSpan?: bigint
}

/**
 * The window width for one RPC, narrowed by what the provider refuses. One
 * instance per RPC client: the learned limit belongs to that provider.
 */
export class LogWindows {
  private readonly defaultSpan: bigint
  private readonly maxSpan: bigint | undefined
  private learned: bigint | undefined

  constructor(options: LogWindowsOptions = {}) {
    this.defaultSpan = options.defaultSpan ?? DEFAULT_LOG_SPAN_BLOCKS
    this.maxSpan = options.maxSpan
  }

  /** The current window, in blocks, inclusive. */
  span(): bigint {
    let span = this.defaultSpan
    if (this.maxSpan !== undefined && this.maxSpan < span) span = this.maxSpan
    if (this.learned !== undefined && this.learned < span) span = this.learned
    return span
  }

  /**
   * Call `fetch` over `[fromBlock, toBlock]` in contiguous windows of at most
   * `span()` blocks, in order. When a call is refused with a narrower limit,
   * that limit is learned and the same window is asked again, narrower. Any
   * other failure, or a refusal that names no narrower limit, is thrown.
   *
   * `stop` ends the scan early once a window's result is enough.
   */
  async scan<T>(
    fromBlock: bigint,
    toBlock: bigint,
    fetch: (from: bigint, to: bigint) => Promise<T>,
    stop?: (result: T) => boolean,
  ): Promise<T[]> {
    const results: T[] = []
    let start = fromBlock
    while (start <= toBlock) {
      const span = this.span()
      const end = start + span - 1n < toBlock ? start + span - 1n : toBlock
      let result: T
      try {
        result = await fetch(start, end)
      } catch (err) {
        const limit = parseLogRangeLimit(err)
        if (limit !== null && BigInt(limit) < end - start + 1n) {
          this.learned = BigInt(limit)
          continue
        }
        throw err
      }
      results.push(result)
      if (stop?.(result)) break
      start = end + 1n
    }
    return results
  }
}
