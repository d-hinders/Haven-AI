/**
 * The merchant inbound index (#4903, read on view since #5012, epic #4885).
 *
 * ## Why this exists
 *
 * Until #4903, an inbound transfer was indexed only as a side effect of
 * someone loading that account's transaction feed (`aggregate.ts`), from the
 * block explorers, newest first and capped per read. A merchant account that
 * received more payments between reads than the cap lost the older ones.
 *
 * This pass reads every USDC transfer into a merchant account
 * (`smart_accounts.is_merchant_account`, #4895) since the account's last
 * indexed block, with no page cap to lose payments behind. Where Alchemy's
 * transfer index is configured for the chain, the index names the
 * transactions and each one is read from the chain by hash
 * (`readInboundTransfersViaIndex`); otherwise the range is read with
 * `eth_getLogs` (`readInboundTransfersInBlockRange`). Either way the payer,
 * amount, log index and block time come from the chain.
 *
 * ## When it runs (#5012)
 *
 * Only while someone is looking. There is no scheduled pass: the owner's Sales
 * reads ask for a refresh (`refreshMerchantAccountIndex`), at most once per
 * `MERCHANT_INDEX_REFRESH_INTERVAL_SECONDS` per account, so a payment appears
 * on an open Sales page within about that interval plus the page's poll. A
 * sale the merchant REPORTS is recorded at once by its own by-hash read
 * (#4897) and needs none of this; the pass is what finds the transfers nobody
 * reported. `runMerchantInboundIndexTick` still walks every account in one go,
 * for tests and for an operator's one-off run.
 *
 * The scheduled pass was removed because it scanned on a clock whether or not
 * anything happened: on a 10-block `eth_getLogs` plan it held dev at ~1M
 * Alchemy compute units an hour (2026-11-20, PR #5004).
 *
 * ## Idempotent, and safe with concurrent refreshes
 *
 * The writes are idempotent: the row identity is (chain, hash, account, log
 * index) — or (chain, hash, account, payer, amount) when the source reports no
 * log index — and the cursor only moves forward (`GREATEST`). Two refreshes
 * racing the same range insert the same rows once and converge on the same
 * cursor. The refresh claim (`claimInboundIndexRefresh`) is what keeps that
 * race rare: it is about cost, not correctness. Both are proven on the
 * real-database harness.
 *
 * ## Indexing continues while merchant services are off
 *
 * The account is chosen by `is_merchant_account = true`, NOT
 * `merchant_service_settings.enabled`. Turning merchant services off keeps the
 * account and its history (#4895).
 *
 * ## Money path
 *
 * Nothing here moves funds, holds a key, or grants authority. It reads the
 * chain and writes the receive index. The rows it writes are UNEARNED until
 * they are matched, exactly like every other inbound row.
 */
import { config } from '../../config.js'
import { isSupportedChain } from '../../domain/chains.js'
import {
  claimInboundIndexRefresh,
  findInboundIndexCursor,
  findMerchantAccountRow,
  listMerchantAccounts,
  upsertInboundIndexCursor,
  type InboundIndexCursor,
  type InboundIndexRefreshClaim,
  type MerchantAccountRow,
} from '../../infra/repositories/inbound-transfers.js'
import {
  findBlockAtOrBefore,
  latestBlockNumber,
  readInboundTransfersInBlockRange,
  readInboundTransfersViaIndex,
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
 * The most blocks one `eth_getLogs` range read walks in a single pass (the
 * fallback when the transfer index is not configured). The cursor advances to
 * the walked block, so the next refresh continues where this one stopped. The
 * index read has no such cap: one index call covers any range, so a view after
 * a quiet spell catches up in one pass.
 */
export const MAX_BLOCKS_PER_PASS = 10_000

/**
 * The most blocks below the head the pass reads again next time. The cursor
 * stops at the settled block so a reorged tail is re-read (#4940 review S1),
 * but `finalized` can lag far behind the head: on Base Sepolia it was 5,445
 * blocks (~3 hours) behind on 2026-11-20. So the cursor may move up to this
 * depth below the head even when `finalized` is further back: the same depth
 * `settledReadBlock` already treats as settled on a chain with no finalized
 * tag. A reorg deeper than this (~10 minutes on Base) would not be re-read.
 * Under the index read the tail costs nothing extra (one call covers it), and
 * it also covers the index lagging the RPC head the pass pinned.
 */
export const MAX_UNSETTLED_REREAD_BLOCKS = SETTLED_CHAIN_READ_DEPTH_BLOCKS

/**
 * The least time between two on-view refreshes of one account (#5012). The
 * Sales page polls every 10 s; this keeps its cost to one index call (and one
 * receipt per new payment) per account per interval, however many tabs or
 * viewers are open.
 */
export const MERCHANT_INDEX_REFRESH_INTERVAL_SECONDS = 30

export interface MerchantIndexDeps {
  listMerchantAccounts: () => Promise<MerchantAccountRow[]>
  findAccount: (accountId: string) => Promise<MerchantAccountRow | null>
  claimRefresh: (accountId: string, minIntervalSeconds: number) => Promise<InboundIndexRefreshClaim>
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
  /** The transfer-index read; null when the index is not configured for the chain. */
  readViaIndex: (
    chainId: number,
    accountAddress: string,
    fromBlock: number,
    toBlock: number,
  ) => Promise<ChainRangeReadResult | null>
  /** The `eth_getLogs` range read, used when `readViaIndex` answers null. */
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
    findAccount: (accountId) => findMerchantAccountRow(accountId),
    claimRefresh: (accountId, minIntervalSeconds) => claimInboundIndexRefresh(accountId, minIntervalSeconds),
    findCursor: (accountId) => findInboundIndexCursor(accountId),
    saveCursor: (input) => upsertInboundIndexCursor(input),
    latestBlock: (chainId) => latestBlockNumber(chainId),
    settledBlock: (chainId) => settledBlockNumber(chainId),
    blockAtOrBefore: (chainId, unixSec) => findBlockAtOrBefore(chainId, unixSec),
    readViaIndex: (chainId, accountAddress, fromBlock, toBlock) =>
      readInboundTransfersViaIndex(chainId, accountAddress, fromBlock, toBlock),
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
   * read got before the failure (not at all when nothing was read).
   */
  failed: number
  /** Accounts skipped because their chain is not served for writes. */
  skipped: number
}

/**
 * What one account's pass did. A read that failed part-way is `failed` AND
 * may have `indexed` rows: it keeps what it read before the failure.
 */
type AccountPassOutcome =
  | { kind: 'indexed'; indexed: number }
  | { kind: 'failed'; indexed: number }
  | { kind: 'skipped' }

/**
 * One pass over one merchant account: read from the cursor to a pinned head,
 * ingest, and move the cursor. A failed read keeps what it read before the
 * failure and moves the cursor no further than that.
 */
async function indexMerchantAccount(
  account: MerchantAccountRow,
  log: InboundIngestLogger,
  deps: MerchantIndexDeps,
): Promise<AccountPassOutcome> {
  // Chain 100 is known but history-only: no `inbound_transfers` write is
  // attempted for it (decision (c), #3635), and a merchant account cannot be
  // created there (#4895 refuses an unsupported network).
  if (!isSupportedChain(account.chainId)) return { kind: 'skipped' }

  try {
    const cursor = await deps.findCursor(account.accountId)
    let fromBlock: number
    if (cursor) {
      fromBlock = cursor.lastIndexedBlock + 1
    } else {
      // First pass: start at the block carrying the account's creation time.
      // Genesis is not affordable and `latest` would miss payments that
      // arrived before the first pass.
      const createdSec = Math.floor(account.createdAt.getTime() / 1000)
      const seed = await deps.blockAtOrBefore(account.chainId, createdSec)
      if (seed === null) {
        log.warn(
          { accountId: account.accountId, chainId: account.chainId },
          'Merchant inbound index: could not resolve the account creation block',
        )
        return { kind: 'failed', indexed: 0 }
      }
      fromBlock = seed
    }

    // The head is pinned once: the read, the settled block and the cursor
    // ceiling all refer to this same number, never to `'latest'` at a later
    // moment, so the cursor cannot pass a block the read did not cover.
    const latest = await deps.latestBlock(account.chainId)
    if (latest < fromBlock) return { kind: 'indexed', indexed: 0 }

    // Read BEFORE the range (#4940 review round 2): every block at or below
    // the cursor saved below must, when it was read, already have been
    // either finalized or at least MAX_UNSETTLED_REREAD_BLOCKS below the
    // head. Taken after the read, a block replaced by a reorg during this
    // pass could be passed over with its pre-reorg contents.
    const settled = await deps.settledBlock(account.chainId)

    // The transfer index first: one call for any range, so no block cap.
    let toBlock = latest
    let read = await deps.readViaIndex(account.chainId, account.accountAddress, fromBlock, toBlock)
    if (read === null) {
      toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_PASS - 1)
      read = await deps.readRange(account.chainId, account.accountAddress, fromBlock, toBlock)
    }

    let legs: InboundTransferLeg[]
    let readThroughBlock: number
    let failed = false
    if (read.ok) {
      legs = read.legs
      readThroughBlock = toBlock
    } else {
      failed = true
      if (!read.partial) {
        log.warn(
          { accountId: account.accountId, chainId: account.chainId, fromBlock, toBlock },
          'Merchant inbound index: chain read failed; cursor left unchanged',
        )
        return { kind: 'failed', indexed: 0 }
      }
      // Keep what was read: it is complete through `readThroughBlock`, and
      // discarding it is how one failed chunk made every pass re-read the
      // whole range (2026-11-20).
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

    // The cursor moves only after the range was read AND written: a failed
    // write leaves it where it was, so the next pass re-reads the range. A
    // read that failed part-way moves it no further than the last block read.
    //
    // And never past the cursor ceiling (#4940 review S1, bounded on
    // 2026-11-20): the higher of the settled block and
    // `MAX_UNSETTLED_REREAD_BLOCKS` under the pinned head. The pass reads up
    // to the head so a payment is indexed at once, but a recent block can
    // still be replaced by a reorg, so the tail above the ceiling is read
    // again next time. When `finalized` lags more than
    // MAX_UNSETTLED_REREAD_BLOCKS behind the head, the ceiling sits ABOVE the
    // settled block: a reorg deeper than that is not re-read here (stated on
    // the constant). With no settled block known, the cursor does not move.
    const cursorCeiling =
      settled === null ? fromBlock - 1 : Math.max(settled, latest - MAX_UNSETTLED_REREAD_BLOCKS)
    const lastIndexedBlock = Math.min(readThroughBlock, cursorCeiling)
    await deps.saveCursor({
      accountId: account.accountId,
      chainId: account.chainId,
      lastIndexedBlock,
    })
    return { kind: failed ? 'failed' : 'indexed', indexed }
  } catch (err) {
    log.warn(
      { err, accountId: account.accountId, chainId: account.chainId },
      'Merchant inbound index: account pass failed',
    )
    return { kind: 'failed', indexed: 0 }
  }
}

/**
 * One pass over every merchant account. Per-account failures are isolated: a
 * failed chain read keeps what it read before the failure, moves that
 * account's cursor no further than that and never stops the other accounts.
 * Not scheduled since #5012; kept for tests and an operator's one-off run.
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
    const outcome = await indexMerchantAccount(account, log, deps)
    if (outcome.kind === 'skipped') {
      result.skipped += 1
      continue
    }
    if (outcome.kind === 'failed') result.failed += 1
    result.indexed += outcome.indexed
  }
  return result
}

export type MerchantIndexRefreshResult =
  | { status: 'disabled' }
  | { status: 'throttled' }
  | { status: 'not_merchant_account' }
  | { status: 'skipped' }
  | { status: 'failed'; indexed: number }
  | { status: 'indexed'; indexed: number }

/**
 * Refresh ONE merchant account's index because its owner is looking at it
 * (#5012). Throttled per account across replicas (`claimInboundIndexRefresh`),
 * and stopped by `MERCHANT_INBOUND_INDEX_DISABLED`. Never throws: a refresh is
 * a side effect of a read, and its failure must never fail the read.
 */
export async function refreshMerchantAccountIndex(
  accountId: string,
  log: InboundIngestLogger,
  deps: MerchantIndexDeps = productionMerchantIndexDeps(),
): Promise<MerchantIndexRefreshResult> {
  if (config.merchantInboundIndexDisabled) return { status: 'disabled' }
  try {
    const claim = await deps.claimRefresh(accountId, MERCHANT_INDEX_REFRESH_INTERVAL_SECONDS)
    if (claim === 'throttled') return { status: 'throttled' }
    const account = await deps.findAccount(accountId)
    if (account === null) return { status: 'not_merchant_account' }
    const outcome = await indexMerchantAccount(account, log, deps)
    if (outcome.kind === 'skipped') return { status: 'skipped' }
    return { status: outcome.kind, indexed: outcome.indexed }
  } catch (err) {
    log.warn({ err, accountId }, 'Merchant inbound index: refresh failed')
    return { status: 'failed', indexed: 0 }
  }
}
