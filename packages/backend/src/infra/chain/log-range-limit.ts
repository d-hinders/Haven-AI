/**
 * The widest `eth_getLogs` block range this environment's RPC provider will
 * serve, per chain (#4012). The x402 settlement sweepers read it before every
 * scan.
 *
 * ## Why this exists
 *
 * Both sweepers asked for 500-block batches, sized "under every provider's
 * served span". Alchemy's FREE plan serves 10. It refuses anything wider with
 * `-32600` "Under the Free tier plan, you can make eth_getLogs requests with up
 * to a 10 block range". The scanners correctly read that as "could not ask".
 * But nothing ever asked for less, so every settled-but-unreported eip3009
 * payment re-sent the same refused request every two minutes for a day: about
 * 245k compute units an hour on a 30M-a-month pool shared with prod.
 *
 * ## The span is the minimum of three values
 *
 * 1. the sweeper's own default (500);
 * 2. `ETH_GETLOGS_MAX_BLOCK_RANGE`, when the operator knows the plan;
 * 3. the limit the provider named in its last refusal on this chain.
 *
 * The third is learned, so the code is correct on either plan without
 * configuration. A learned limit EXPIRES after {@link LOG_RANGE_LIMIT_TTL_MS},
 * so a plan upgrade takes effect without a redeploy. Re-learning costs one
 * refused call per chain per TTL.
 *
 * ## What this module will NOT do
 *
 * It never turns a refusal into an answer. The scanners still return "could
 * not ask" for the batch the provider refused. This module only changes how
 * wide the NEXT request is. A message it cannot parse teaches nothing: that
 * failure stays an ordinary unavailable read, and the sweepers back it off.
 */
import { config } from '../../config.js'

/** How long a limit learned from a refusal is trusted before the default is tried again. */
export const LOG_RANGE_LIMIT_TTL_MS = 60 * 60 * 1000

/** Why a sweep's span is narrower than it asked for, as the log line names it. */
export const LOG_RANGE_LIMIT_REASON = 'provider_log_range_limit'

const learned = new Map<number, { limit: number; learnedAtMs: number }>()

/** Test seam: the learned limits are process-lifetime state. */
export function resetLogRangeLimits(): void {
  learned.clear()
}

/**
 * The range-limit phrasings the providers Haven has used actually return.
 * Each pattern captures the number and an optional `K`. Anchored on "block
 * range" wording, so a RESULT-size cap ("query returned more than 10000
 * results") is not mistaken for a range cap.
 */
const RANGE_LIMIT_PATTERNS: RegExp[] = [
  // Alchemy: "…with up to a 10 block range", "…up to a 2K block range…"
  /up to an? ([\d,]+)\s*(k)?\s*block range/i,
  // geth-style and several hosted nodes: "exceed maximum block range: 50000"
  /maximum block range(?: is| of|:)?\s*([\d,]+)\s*(k)?/i,
  // QuickNode: "eth_getLogs is limited to a 10,000 range"
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
  // ethers v6 nests the provider's JSON-RPC error under `error` and `info.error`.
  out.push(...messagesOf(e.error, depth + 1))
  if (e.info && typeof e.info === 'object') out.push(...messagesOf((e.info as Record<string, unknown>).error, depth + 1))
  out.push(...messagesOf(e.cause, depth + 1))
  return out
}

/**
 * The block-range cap a provider's `eth_getLogs` refusal names, or `null`
 * when the error is not a range refusal or names no usable number.
 */
export function parseLogRangeLimit(err: unknown): number | null {
  for (const message of messagesOf(err)) {
    for (const pattern of RANGE_LIMIT_PATTERNS) {
      const match = pattern.exec(message)
      if (!match) continue
      const base = Number(match[1].replace(/,/g, ''))
      const limit = match[2] ? base * 1000 : base
      if (Number.isInteger(limit) && limit > 0) return limit
    }
  }
  return null
}

/**
 * Record a failed `eth_getLogs` on `chainId`. When the error names a range
 * cap, it becomes this chain's learned limit and is returned. Any other
 * failure teaches nothing and returns `null`.
 */
export function noteLogScanFailure(chainId: number, err: unknown, nowMs: number = Date.now()): number | null {
  const limit = parseLogRangeLimit(err)
  if (limit === null) return null
  learned.set(chainId, { limit, learnedAtMs: nowMs })
  return limit
}

/** The limit last learned for `chainId`, while it is still fresh. */
export function learnedLogRangeLimit(chainId: number, nowMs: number = Date.now()): number | null {
  const entry = learned.get(chainId)
  if (!entry) return null
  if (nowMs - entry.learnedAtMs >= LOG_RANGE_LIMIT_TTL_MS) {
    learned.delete(chainId)
    return null
  }
  return entry.limit
}

/**
 * The span one `eth_getLogs` call on `chainId` may cover: the caller's
 * default, narrowed by the env cap and by a fresh learned limit. Never below 1.
 */
export function effectiveLogBatchBlocks(
  chainId: number,
  defaultBlocks: number,
  nowMs: number = Date.now(),
): number {
  let span = defaultBlocks
  if (config.getLogsMaxBlockRange !== null) span = Math.min(span, config.getLogsMaxBlockRange)
  const fresh = learnedLogRangeLimit(chainId, nowMs)
  if (fresh !== null) span = Math.min(span, fresh)
  return Math.max(1, span)
}
