/**
 * The scheduled merchant inbound index (#4903, epic #4885).
 *
 * ## Why this exists
 *
 * Until this pass, an inbound transfer was indexed only as a side effect of
 * someone loading that account's transaction feed (`aggregate.ts`), from the
 * block explorers, newest first and capped per read. A merchant account that
 * nobody browses was not indexed, and one that received more payments between
 * reads than the cap lost the older ones. For merchant services the index has
 * to be complete without anyone looking.
 *
 * This pass walks every account marked as a merchant account
 * (`smart_accounts.is_merchant_account`, #4895) and reads every USDC transfer
 * into it since the last indexed block, straight from the chain
 * (`eth_getLogs`, `chain-read.ts`). It does not consult the explorer, so there
 * is no page cap to lose payments behind.
 *
 * ## The stated figure
 *
 * The job runs every 5 minutes (`background-jobs.ts`), so a payment into a
 * merchant account is indexed **within 5 minutes** of the next tick, plus the
 * tick's own runtime, with no dashboard open. A backlog (a deployment that was
 * down, or an account whose first pass starts at its creation block) is walked
 * at up to `MAX_BLOCKS_PER_PASS` blocks per tick, so completeness is eventual
 * and bounded rather than unbounded in one tick.
 *
 * ## Idempotent, and safe with two replicas
 *
 * Two independent guarantees, and both are proven on the real-database
 * harness:
 *
 * - The job is leader-gated (`LEADER_LOCK_KEYS.merchantInboundIndex`), so in a
 *   multi-replica deployment exactly one replica runs a tick.
 * - The writes are idempotent regardless: the row identity is
 *   (chain, hash, account, log index) — or (chain, hash, account, payer,
 *   amount) when the source reports no log index — and the cursor only moves
 *   forward (`GREATEST`). Two replicas racing the same range insert the same
 *   rows once and converge on the same cursor.
 *
 * ## Indexing continues while merchant services are off
 *
 * The account list is `is_merchant_account = true`, NOT
 * `merchant_service_settings.enabled`. Turning merchant services off keeps the
 * account and its history (#4895); the history has to stay complete, so the
 * pass keeps running for it.
 *
 * ## Money path
 *
 * Nothing here moves funds, holds a key, or grants authority. It reads the
 * chain and writes the receive index. The rows it writes are UNEARNED until
 * they are matched, exactly like every other inbound row.
 */
import { isSupportedChain } from '../../domain/chains.js'
import {
  findInboundIndexCursor,
  listMerchantAccounts,
  upsertInboundIndexCursor,
  type InboundIndexCursor,
  type MerchantAccountRow,
} from '../../infra/repositories/inbound-transfers.js'
import {
  findBlockAtOrBefore,
  latestBlockNumber,
  readInboundTransfersInBlockRange,
  settledBlockNumber,
  type ChainRangeReadResult,
} from './chain-read.js'
import { SETTLED_CHAIN_READ_DEPTH_BLOCKS } from '../../infra/chain/settled-read-block.js'
import {
  ingestInboundTransfers,
  type InboundIngestLogger,
  type IngestInboundTransferAccount,
  type InboundTransferLeg,
} from './receive.js'

/**
 * The most blocks one account may be walked in a single tick. Steady state is
 * far below it (5 minutes is ~150 Base blocks); it exists so a long outage or
 * a first pass cannot make one tick unbounded. The cursor advances to the
 * walked block, so the next tick continues where this one stopped.
 */
export const MAX_BLOCKS_PER_PASS = 10_000

/**
 * The most blocks below the head the pass reads again on the next tick. The
 * cursor stops at the settled block so a reorged tail is re-read (#4940 review
 * S1), but `finalized` can lag far behind the head: on Base Sepolia it was
 * 5,445 blocks (~3 hours) behind on 2026-11-20. Re-reading all of that every 5
 * minutes, at 10 blocks per `eth_getLogs` call on Alchemy's free plan, is what
 * held dev at ~1M compute units an hour. So the cursor may move up to this
 * depth below the head even when `finalized` is further back: the same depth
 * `settledReadBlock` already treats as settled on a chain with no finalized
 * tag. A reorg deeper than this (~10 minutes on Base) would not be re-read by
 * the scheduled pass.
 */
export const MAX_UNSETTLED_REREAD_BLOCKS = SETTLED_CHAIN_READ_DEPTH_BLOCKS

export interface MerchantIndexDeps {
  listMerchantAccounts: () => Promise<MerchantAccountRow[]>
  findCursor: (accountId: string) => Promise<InboundIndexCursor | null>
  saveCursor: (input: {
    accountId: string
    chainId: number
    lastIndexedBlock: number
  }) => Promise<void>
  latestBlock: (chainId: number) => Promise<number>
  /** The newest block a reorg cannot take back, or null when there is none. */
  settledBlock: (chainId: number) => Promise<number | null>
  blockAtOrBefore: (chainId: number, unixSec: number) => Promise<number | null>
  readRange: (
    chainId: number,
    accountAddress: string,
    fromBlock: number,
    toBlock: number,
  ) => Promise<ChainRangeReadResult>
  ingest: (
    account: IngestInboundTransferAccount,
    legs: InboundTransferLeg[],
    log: InboundIngestLogger,
  ) => Promise<number>
}

/** The real dependencies. Injectable so the pass is testable without an RPC. */
export function productionMerchantIndexDeps(): MerchantIndexDeps {
  return {
    listMerchantAccounts: () => listMerchantAccounts(),
    findCursor: (accountId) => findInboundIndexCursor(accountId),
    saveCursor: (input) => upsertInboundIndexCursor(input),
    latestBlock: (chainId) => latestBlockNumber(chainId),
    settledBlock: (chainId) => settledBlockNumber(chainId),
    blockAtOrBefore: (chainId, unixSec) => findBlockAtOrBefore(chainId, unixSec),
    readRange: (chainId, accountAddress, fromBlock, toBlock) =>
      readInboundTransfersInBlockRange(chainId, accountAddress, fromBlock, toBlock),
    ingest: (account, legs, log) => ingestInboundTransfers(account, legs, log),
  }
}

export interface MerchantIndexTickResult {
  /** Merchant accounts the pass considered. */
  accounts: number
  /** Rows newly indexed across every account. */
  indexed: number
  /**
   * Accounts whose chain read failed. Their cursor moved only as far as the
   * read got before the failure (not at all when no chunk was read).
   */
  failed: number
  /** Accounts skipped because their chain is not served for writes. */
  skipped: number
}

/**
 * One pass over every merchant account. Per-account failures are isolated: a
 * failed chain read keeps what it read before the failure, moves that
 * account's cursor no further than that (so the next tick retries from the
 * first block it could not read) and never stops the other accounts.
 */
export async function runMerchantInboundIndexTick(
  log: InboundIngestLogger,
  deps: MerchantIndexDeps = productionMerchantIndexDeps(),
): Promise<MerchantIndexTickResult> {
  const result: MerchantIndexTickResult = { accounts: 0, indexed: 0, failed: 0, skipped: 0 }

  let accounts: MerchantAccountRow[]
  try {
    accounts = await deps.listMerchantAccounts()
  } catch (err) {
    log.warn({ err }, 'Merchant inbound index: account list failed')
    result.failed += 1
    return result
  }

  for (const account of accounts) {
    result.accounts += 1

    // Chain 100 is known but history-only: no `inbound_transfers` write is
    // attempted for it (decision (c), #3635), and a merchant account cannot be
    // created there (#4895 refuses an unsupported network).
    if (!isSupportedChain(account.chainId)) {
      result.skipped += 1
      continue
    }

    try {
      const cursor = await deps.findCursor(account.accountId)
      let fromBlock: number
      if (cursor) {
        fromBlock = cursor.lastIndexedBlock + 1
      } else {
        // First pass: start at the block carrying the account's creation time.
        // Genesis is not affordable and `latest` would miss payments that
        // arrived before the first tick.
        const createdSec = Math.floor(account.createdAt.getTime() / 1000)
        const seed = await deps.blockAtOrBefore(account.chainId, createdSec)
        if (seed === null) {
          result.failed += 1
          log.warn(
            { accountId: account.accountId, chainId: account.chainId },
            'Merchant inbound index: could not resolve the account creation block',
          )
          continue
        }
        fromBlock = seed
      }

      const latest = await deps.latestBlock(account.chainId)
      if (latest < fromBlock) continue

      const toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_PASS - 1)
      // Read BEFORE the range (#4940 review round 2): every block at or below
      // the cursor saved below must already have been settled when it was
      // read. Taken after the read, a block replaced by a reorg and finalized
      // during this pass could be passed over with its pre-reorg contents.
      const settled = await deps.settledBlock(account.chainId)
      const read = await deps.readRange(
        account.chainId,
        account.accountAddress,
        fromBlock,
        toBlock,
      )
      let legs: InboundTransferLeg[]
      let readThroughBlock: number
      if (read.ok) {
        legs = read.legs
        readThroughBlock = toBlock
      } else {
        result.failed += 1
        if (!read.partial) {
          log.warn(
            { accountId: account.accountId, chainId: account.chainId, fromBlock, toBlock },
            'Merchant inbound index: chain read failed; cursor left unchanged',
          )
          continue
        }
        // Keep the chunks that were read: they are complete through
        // `readThroughBlock`, and discarding them is how one failed chunk made
        // every tick re-read the whole range (2026-11-20).
        legs = read.partial.legs
        readThroughBlock = read.partial.readThroughBlock
        log.warn(
          {
            accountId: account.accountId,
            chainId: account.chainId,
            fromBlock,
            toBlock,
            readThroughBlock,
          },
          'Merchant inbound index: chain read failed part-way; kept the blocks read before it',
        )
      }

      const indexed = await deps.ingest(
        {
          id: account.accountId,
          userId: account.userId,
          accountAddress: account.accountAddress,
          chainId: account.chainId,
        },
        legs,
        log,
      )
      result.indexed += indexed

      // The cursor moves only after the range was read AND written: a failed
      // write leaves it where it was, so the next tick re-reads the range. A
      // read that failed part-way moves it no further than the last block read.
      //
      // And never past the settled block (#4940 review S1), bounded below by
      // `MAX_UNSETTLED_REREAD_BLOCKS` under the head: the pass reads up to
      // `latest` so a payment is indexed within a tick, but a block above the
      // settled one can still be replaced by a reorg. Keeping the cursor at or
      // below it means the unsettled tail is read again on every pass, so a
      // payment that lands in a replacement block at a height already walked is
      // still found. Re-reading is cheap only while the tail is short, hence
      // the bound. With no settled block known, the cursor does not move.
      const cursorCeiling =
        settled === null ? fromBlock - 1 : Math.max(settled, latest - MAX_UNSETTLED_REREAD_BLOCKS)
      const lastIndexedBlock = Math.min(readThroughBlock, cursorCeiling)
      await deps.saveCursor({
        accountId: account.accountId,
        chainId: account.chainId,
        lastIndexedBlock,
      })
    } catch (err) {
      result.failed += 1
      log.warn(
        { err, accountId: account.accountId, chainId: account.chainId },
        'Merchant inbound index: account pass failed',
      )
    }
  }

  return result
}
