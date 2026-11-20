/**
 * The chain reads behind the merchant inbound index (#4903, epic #4885).
 *
 * Two reads, both of which ask the CHAIN, never a caller:
 *
 * 1. `readInboundTransfersByTxHash` — one transaction by hash: the USDC
 *    `Transfer` logs in its receipt whose `to` is the account. This is the
 *    primitive #4897 uses to check a sale record at once, and the one the
 *    owner ingest route now uses instead of trusting a caller's description of
 *    a transfer. A transaction that did not pay the account yields an EMPTY
 *    leg list — "there is none" — and never a caller-supplied value.
 * 2. `readInboundTransfersInBlockRange` — every USDC `Transfer` into the
 *    account between two blocks, for the merchant index pass when no transfer
 *    index is configured (#5012 reads through the index first,
 *    `readInboundTransfersViaIndex`). `eth_getLogs` is the
 *    right primitive here and the explorer is not: the explorer's account
 *    history is newest-first and capped per read, which is exactly how a
 *    merchant's older payments were lost (#4903's premise), while `getLogs`
 *    returns every log in the range with its exact `logIndex` — the on-chain
 *    half of the row identity.
 *
 * ## What is deliberately NOT trusted
 *
 * Nothing in this module takes a payer, an amount, a token or a block time from
 * a caller. The token is the chain registry's settlement asset, resolved by
 * ADDRESS (`settlementTokenForChain`), so a contract that merely names itself
 * USDC is not the settlement asset. The payer, amount and log index come from
 * the log; the block time from the block.
 *
 * ## Failure handling — fail closed, and never read an outage as "none"
 *
 * `ok: false` means the chain could not be read. It is NOT an empty result: an
 * RPC outage must never become "this transaction did not pay you", because the
 * caller would then record a sale as unpaid. The two outcomes are kept
 * distinct for exactly that reason, the same shape
 * `infra/chain/settlement-transfer-verifier.ts` uses.
 *
 * ## Cost
 *
 * The range read is chunked by `effectiveLogBatchBlocks` (the provider's own
 * served span, learned from its refusals — #4012), so a pass costs one
 * `eth_getLogs` per chunk of elapsed blocks and one `eth_getBlockByNumber` per
 * DISTINCT block that carried a payment (cached per chain+block). A quiet pass
 * over at most 500 blocks is one `getLogs` call.
 *
 * On a provider that serves only 10 blocks per call (Alchemy's free plan) a
 * chunk is 10 blocks, so a range costs one call per 10 blocks. That is why a
 * failed range read keeps the chunks it did read (`ChainRangeReadResult.partial`):
 * before it did, one failed chunk discarded the whole range, the next tick asked
 * for all of it again, and dev spent ~1M compute units an hour re-reading the
 * same ~9,500 blocks (2026-11-20).
 */
import { ethers } from 'ethers'
import { settlementTokenForChain } from '../../domain/chains.js'
import { getProvider } from '../../infra/chain/relayer-reads.js'
import { discoverInboundTokenTransferHashes } from '../../infra/explorer-api.js'
import {
  effectiveLogBatchBlocks,
  noteLogScanFailure,
} from '../../infra/chain/log-range-limit.js'

/** `Transfer(address,address,uint256)` — the ERC-20 event every USDC leg emits. */
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

const ERC20_TRANSFER_IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/**
 * The widest range one `eth_getLogs` call asks for before the provider's own
 * limit narrows it (`effectiveLogBatchBlocks`). 500 is the settlement
 * sweepers' default and the value #4012 sized; the learned limit is what makes
 * it correct on a free-tier plan.
 */
export const DEFAULT_LOG_BATCH_BLOCKS = 500

/** One USDC transfer into the account, as the chain reports it. */
export interface ChainInboundLeg {
  txHash: string
  /** The log's index in its transaction — the on-chain half of the row identity. */
  logIndex: number
  payerAddress: string
  tokenAddress: string
  amountRaw: string
  blockNumber: number
  blockTime: Date
}

export type ChainReadResult =
  | { ok: true; legs: ChainInboundLeg[] }
  | { ok: false; reason: 'rpc_unavailable' }

/** Block timestamps are global per chain+block; a small cache keeps a pass cheap. */
const BLOCK_TIME_CACHE_MAX = 5_000
const blockTimeCache = new Map<string, number>()

/** Test seam: the cache is process-lifetime state. */
export function resetBlockTimeCache(): void {
  blockTimeCache.clear()
}

async function blockTimeSec(chainId: number, blockNumber: number): Promise<number | null> {
  const key = `${chainId}:${blockNumber}`
  const cached = blockTimeCache.get(key)
  if (cached !== undefined) return cached
  const block = await getProvider(chainId).getBlock(blockNumber)
  if (!block) return null
  if (blockTimeCache.size >= BLOCK_TIME_CACHE_MAX) blockTimeCache.clear()
  blockTimeCache.set(key, block.timestamp)
  return block.timestamp
}

/** The settlement token's address on this chain, lowercased, or null. */
function settlementTokenAddress(chainId: number): string | null {
  const token = settlementTokenForChain(chainId)
  return token?.address ? token.address.toLowerCase() : null
}

/** A zero-value transfer is not a payment (#4903): it is left out everywhere. */
function isZeroAmountRaw(value: string): boolean {
  return /^0+$/.test(value)
}

/**
 * Decode one log into a leg for `accountAddress`, or null when it is not a
 * settlement-token `Transfer` INTO that account, or carries no value.
 */
function legFromLog(
  log: ethers.Log,
  tokenAddress: string,
  accountAddress: string,
  blockTime: Date,
): ChainInboundLeg | null {
  return legToAnyOf(log, tokenAddress, new Set([accountAddress]), blockTime)?.leg ?? null
}

/**
 * Decode one log into a leg INTO any of `recipients` (lower-case), with the
 * recipient it went to, or null when it is not a settlement-token `Transfer`
 * into one of them, or carries no value.
 */
function legToAnyOf(
  log: ethers.Log,
  tokenAddress: string,
  recipients: ReadonlySet<string>,
  blockTime: Date,
): { leg: ChainInboundLeg; toAddress: string } | null {
  if (log.address.toLowerCase() !== tokenAddress) return null
  let parsed: ethers.LogDescription | null = null
  try {
    parsed = ERC20_TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null
  }
  if (!parsed) return null
  const to = String(parsed.args.to).toLowerCase()
  if (!recipients.has(to)) return null
  const amountRaw = (parsed.args.value as bigint).toString()
  if (isZeroAmountRaw(amountRaw)) return null
  return {
    toAddress: to,
    leg: {
      txHash: log.transactionHash,
      logIndex: log.index,
      payerAddress: String(parsed.args.from).toLowerCase(),
      tokenAddress,
      amountRaw,
      blockNumber: log.blockNumber,
      blockTime,
    },
  }
}

/** A leg and the address it was paid to (#4952). */
export interface ChainRecipientLeg {
  leg: ChainInboundLeg
  /** The recipient, lower-case. */
  toAddress: string
}

/**
 * One transaction, read from the chain, with what `readInboundTransfersByTxHash`
 * folds away (#4897): whether the receipt exists at all, and where it sits.
 * A sale needs the difference, because "no receipt yet" is a retry and "a
 * receipt with no leg to the account" is a refusal.
 */
export type ChainTransactionRead =
  | { ok: false; reason: 'rpc_unavailable' }
  | { ok: true; receiptFound: false; legs: []; otherLegs?: [] }
  | {
      ok: true
      receiptFound: true
      /** The block the receipt was mined in. */
      blockNumber: number
      /** The chain's head when the receipt was read, from the same provider. */
      latestBlock: number
      legs: ChainInboundLeg[]
      /**
       * The USDC legs to the `alsoToAddresses` the caller named (#4952), each
       * with the address it went to. Present only when the caller named any,
       * so a caller that names none gets the answer it always did.
       */
      otherLegs?: ChainRecipientLeg[]
    }

/**
 * The transaction behind `txHash`: its receipt's USDC legs into
 * `accountAddress`, the receipt's block and the chain head (#4897). Nothing is
 * taken from a caller; `ok: false` is an unreadable chain, never "none".
 * `alsoToAddresses` (#4952) names further recipients whose legs are returned
 * apart in `otherLegs`; `legs` is unchanged by it.
 */
export async function readInboundTransactionByTxHash(
  chainId: number,
  accountAddress: string,
  txHash: string,
  alsoToAddresses: readonly string[] = [],
): Promise<ChainTransactionRead> {
  const tokenAddress = settlementTokenAddress(chainId)
  const account = accountAddress.toLowerCase()
  const provider = getProvider(chainId)

  let receipt: ethers.TransactionReceipt | null
  try {
    receipt = await provider.getTransactionReceipt(txHash)
  } catch {
    return { ok: false, reason: 'rpc_unavailable' }
  }
  if (!receipt) return { ok: true, receiptFound: false, legs: [] }

  let latestBlock: number
  let blockTime: Date
  try {
    latestBlock = await provider.getBlockNumber()
    const seconds = await blockTimeSec(chainId, receipt.blockNumber)
    if (seconds === null) return { ok: false, reason: 'rpc_unavailable' }
    blockTime = new Date(seconds * 1000)
  } catch {
    return { ok: false, reason: 'rpc_unavailable' }
  }

  const legs: ChainInboundLeg[] = []
  const otherLegs: ChainRecipientLeg[] = []
  if (tokenAddress) {
    const others = new Set(alsoToAddresses.map((a) => a.toLowerCase()))
    for (const log of receipt.logs) {
      const leg = legFromLog(log, tokenAddress, account, blockTime)
      if (leg) legs.push(leg)
      else if (others.size > 0) {
        const other = legToAnyOf(log, tokenAddress, others, blockTime)
        if (other) otherLegs.push(other)
      }
    }
  }
  return {
    ok: true,
    receiptFound: true,
    blockNumber: receipt.blockNumber,
    latestBlock,
    legs,
    ...(alsoToAddresses.length > 0 ? { otherLegs } : {}),
  }
}

/**
 * The USDC transfers INTO `accountAddress` carried by one transaction, read
 * from the chain. `ok: true` with an empty list means the chain says there is
 * none (unknown hash, unmined, reverted, or no settlement-token leg to the
 * account). `ok: false` means the chain could not be read — never "none".
 */
export async function readInboundTransfersByTxHash(
  chainId: number,
  accountAddress: string,
  txHash: string,
): Promise<ChainReadResult> {
  const tokenAddress = settlementTokenAddress(chainId)
  if (!tokenAddress) return { ok: true, legs: [] }
  const account = accountAddress.toLowerCase()

  let receipt: ethers.TransactionReceipt | null
  try {
    receipt = await getProvider(chainId).getTransactionReceipt(txHash)
  } catch {
    return { ok: false, reason: 'rpc_unavailable' }
  }
  if (!receipt) return { ok: true, legs: [] }

  let blockTime: Date
  try {
    const seconds = await blockTimeSec(chainId, receipt.blockNumber)
    if (seconds === null) return { ok: false, reason: 'rpc_unavailable' }
    blockTime = new Date(seconds * 1000)
  } catch {
    return { ok: false, reason: 'rpc_unavailable' }
  }

  const legs: ChainInboundLeg[] = []
  for (const log of receipt.logs) {
    const leg = legFromLog(log, tokenAddress, account, blockTime)
    if (leg) legs.push(leg)
  }
  return { ok: true, legs }
}

/**
 * The range read's answer. A failure is never "none", but it may carry the
 * progress made before it: `partial` is every leg in
 * `[fromBlock, partial.readThroughBlock]`, complete for that sub-range, so the
 * merchant index pass can keep it and move its cursor that far instead of
 * throwing the whole range away and asking for all of it again next time (the dev
 * Alchemy incident, 2026-11-20). `partial` is null when no chunk was read.
 */
export type ChainRangeReadResult =
  | { ok: true; legs: ChainInboundLeg[] }
  | {
      ok: false
      reason: 'rpc_unavailable'
      partial: { legs: ChainInboundLeg[]; readThroughBlock: number } | null
    }

/**
 * Every USDC transfer INTO `accountAddress` in `[fromBlock, toBlock]`, read
 * with `eth_getLogs` in provider-sized chunks. Complete for the range: there is
 * no page cap, so a burst of payments between two passes is not truncated.
 *
 * Chunks are read in block order. When one fails, the read stops there and
 * reports what the chunks before it returned as `partial` — complete through
 * the last block read, and nothing claimed past it.
 */
export async function readInboundTransfersInBlockRange(
  chainId: number,
  accountAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<ChainRangeReadResult> {
  const tokenAddress = settlementTokenAddress(chainId)
  if (!tokenAddress) return { ok: true, legs: [] }
  if (fromBlock > toBlock) return { ok: true, legs: [] }

  const account = accountAddress.toLowerCase()
  const topicTo = ethers.zeroPadValue(account, 32)
  const provider = getProvider(chainId)
  const rawLogs: ethers.Log[] = []

  // The last block every chunk up to which was read; `fromBlock - 1` = none yet.
  let readThrough = fromBlock - 1
  let failed = false
  let start = fromBlock
  while (start <= toBlock) {
    const span = effectiveLogBatchBlocks(chainId, DEFAULT_LOG_BATCH_BLOCKS)
    const end = Math.min(toBlock, start + span - 1)
    try {
      const logs = await provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC, null, topicTo],
        fromBlock: start,
        toBlock: end,
      })
      rawLogs.push(...logs)
    } catch (err) {
      // Teaches the next request a narrower span when the provider named one;
      // this read still reports "could not ask" rather than an empty answer.
      noteLogScanFailure(chainId, err)
      failed = true
      break
    }
    readThrough = end
    start = end + 1
  }

  const legs: ChainInboundLeg[] = []
  const times = new Map<number, Date>()
  // Walk in block order (sorted, not trusted from the provider): a block time
  // that cannot be read stops the walk there, and every leg in an earlier
  // block must already have been taken for the partial result to be complete.
  rawLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
  for (const log of rawLogs) {
    let blockTime = times.get(log.blockNumber)
    if (!blockTime) {
      let seconds: number | null = null
      try {
        seconds = await blockTimeSec(chainId, log.blockNumber)
      } catch {
        seconds = null
      }
      if (seconds === null) {
        failed = true
        readThrough = Math.min(readThrough, log.blockNumber - 1)
        break
      }
      blockTime = new Date(seconds * 1000)
      times.set(log.blockNumber, blockTime)
    }
    const leg = legFromLog(log, tokenAddress, account, blockTime)
    if (leg) legs.push(leg)
  }

  if (!failed) return { ok: true, legs }
  return {
    ok: false,
    reason: 'rpc_unavailable',
    partial: readThrough >= fromBlock ? { legs, readThroughBlock: readThrough } : null,
  }
}

/** The seams `readInboundTransfersViaIndex` reads through; injectable for tests. */
export interface IndexReadDeps {
  discover: typeof discoverInboundTokenTransferHashes
  readByHash: typeof readInboundTransfersByTxHash
}

const PRODUCTION_INDEX_READ_DEPS: IndexReadDeps = {
  discover: discoverInboundTokenTransferHashes,
  readByHash: readInboundTransfersByTxHash,
}

/**
 * Every USDC transfer INTO `accountAddress` in `[fromBlock, toBlock]`, found
 * through Alchemy's transfer index and read from the chain (#5012), or null
 * when the index is not configured for the chain (the caller then reads the
 * range with `readInboundTransfersInBlockRange`).
 *
 * The index only names the transactions. Each one is then read by hash, the
 * same read the sales ingest uses, so the payer, amount, block time and the
 * exact log index of every leg come from the chain's receipt, never from the
 * index. Two byte-identical legs in one transaction therefore stay two legs
 * (owner decision on #5012, option (b)). An idle range costs one index call
 * and no receipt.
 *
 * Failure keeps the same shape as the range read: never "none", and `partial`
 * holds every leg through the last block known complete. A receipt that
 * cannot be read ends the partial result before that transaction's block.
 */
export async function readInboundTransfersViaIndex(
  chainId: number,
  accountAddress: string,
  fromBlock: number,
  toBlock: number,
  deps: IndexReadDeps = PRODUCTION_INDEX_READ_DEPS,
): Promise<ChainRangeReadResult | null> {
  const tokenAddress = settlementTokenAddress(chainId)
  if (!tokenAddress) return { ok: true, legs: [] }
  if (fromBlock > toBlock) return { ok: true, legs: [] }

  const found = await deps.discover(chainId, accountAddress, tokenAddress, fromBlock, toBlock)
  if (found === null) return null

  // The highest block every leg at or below which is in `legs`.
  let readThrough = found.ok ? toBlock : found.readThroughBlock ?? fromBlock - 1
  let failed = !found.ok
  const legs: ChainInboundLeg[] = []
  for (const txHash of found.txHashes) {
    const read = await deps.readByHash(chainId, accountAddress, txHash)
    if (!read.ok) {
      // The failed receipt's block is unknown, but hashes arrive oldest
      // first, so it is at or after the highest block read so far, and may BE
      // that block: stop just before it. The legs of that block are dropped
      // below and read again next time (the row identity dedupes).
      failed = true
      const highest = legs.reduce((max, leg) => Math.max(max, leg.blockNumber), fromBlock)
      readThrough = Math.min(readThrough, highest - 1)
      break
    }
    legs.push(...read.legs)
  }

  // A partial discovery may name a transaction in its unfinished last block;
  // keep only what lies inside the range this read can vouch for.
  const kept = legs.filter((leg) => leg.blockNumber <= readThrough)
  if (!failed) return { ok: true, legs: kept }
  return {
    ok: false,
    reason: 'rpc_unavailable',
    partial: readThrough >= fromBlock ? { legs: kept, readThroughBlock: readThrough } : null,
  }
}

/** The chain's current block number. */
export async function latestBlockNumber(chainId: number): Promise<number> {
  return getProvider(chainId).getBlockNumber()
}

/**
 * A block whose contents will not be reorganised away (`finalized`, else
 * `SETTLED_CHAIN_READ_DEPTH_BLOCKS` below the head), or null when the chain
 * offers none. The merchant index keeps its cursor at or below the higher of
 * this block and `MAX_UNSETTLED_REREAD_BLOCKS` under the head, so the recent
 * tail is read again on every pass (#4940 review S1).
 */
export async function settledBlockNumber(chainId: number): Promise<number | null> {
  const { settledReadBlock } = await import('../../infra/chain/settled-read-block.js')
  return settledReadBlock(getProvider(chainId))
}

/**
 * The highest block whose timestamp is at or before `unixSec` — the seed for a
 * merchant account's first pass, so the pass starts at the account's creation
 * rather than at genesis (a full-history scan is not affordable) or at
 * `latest` (which would miss payments that arrived before the first tick).
 *
 * Binary search over block timestamps: ~25 `eth_getBlockByNumber` calls on a
 * chain with tens of millions of blocks, once per account.
 */
export async function findBlockAtOrBefore(
  chainId: number,
  unixSec: number,
): Promise<number | null> {
  const provider = getProvider(chainId)
  let hi: number
  try {
    hi = await provider.getBlockNumber()
  } catch {
    return null
  }
  let lo = 0
  try {
    const head = await provider.getBlock(hi)
    if (!head) return null
    if (head.timestamp <= unixSec) return hi
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const block = await provider.getBlock(mid)
      if (!block) return null
      if (block.timestamp <= unixSec) lo = mid + 1
      else hi = mid
    }
  } catch {
    return null
  }
  return Math.max(0, lo - 1)
}
