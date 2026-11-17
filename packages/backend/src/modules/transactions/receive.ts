/**
 * The receive side (#3333, epic #3328): ingest + match for the persisted
 * inbound-transfer index. Widened by #4903 (epic #4885) to index a merchant
 * account without anyone looking, and to read one transaction by hash.
 *
 * Three entry points:
 *
 * 1. `ingestInboundTransfers` — the legs that came back INBOUND to the
 *    account's address are upserted into `inbound_transfers`. Two sources feed
 *    it, and both are the chain's own answer: the explorer read the dashboard
 *    already performs (`aggregate.ts`, no second explorer call) and the
 *    scheduled merchant pass's `eth_getLogs` read (`merchant-index.ts`). USDC
 *    only: the slice's asset is the settlement token, and the ledger is a USDC
 *    receive balance, not a general token inventory. Idempotent per
 *    (chain, hash, account, log index) — and per (chain, hash, account, payer,
 *    amount) when the source reports no log index (migration 127).
 *
 * 2. `readInboundTransferByTxHash` — one transaction by hash, read from the
 *    CHAIN: the USDC transfers to the account, or none. This is the primitive
 *    #4897 uses to check a sale record at once, and the one the owner ingest
 *    route uses instead of trusting a caller's description of a transfer. It
 *    never returns a caller-supplied value.
 *
 * 3. `matchInboundTransferForAccount` — one row is linked to its evidence, by
 *    one of exactly two match kinds the issue names:
 *
 *    - `x402_payto`: an x402 settlement the account was `payTo` FOR —
 *      resolved by the settlement's own tx hash (the #3333 key), scoped to
 *      THIS account's confirmed intents. Read-only evidence, never widened:
 *      the match grants nothing, it records that the payer's document named
 *      the same on-chain event the account already sees.
 *    - `receipt`: a receipt supplied for the transfer — a merchant receipt
 *      document (from the #956 capture) whose hash matches, or a payer-supplied
 *      document dropped on the new public drop. The document is a REFERENCE
 *      (`matched_receipt_id`), never a permission.
 *
 *    The match is one-way and set exactly once (repository WHERE
 *    `match_kind IS NULL`); the winner of a concurrent race records its link,
 *    the loser leaves the row untouched.
 *
 * Authority note (money-path gate): nothing here holds a key, signs, moves
 * funds, or settles for anyone. Matching does not widen authority — an
 * unmatched row is UNEARNED and nothing is delivered on it; the match only
 * flips the ledger's earned flag. The off-ramp hand-off is NOT here: it is
 * the owner's own transfer through `rails/hybrid-transfers.ts` with the
 * destination constrained to the owner-saved off-ramp address.
 */
import { settlementTokenForChain } from '../../domain/chains.js'
import {
  insertInboundTransfer,
  findUnmatchedByTxHash,
  matchInboundTransfer,
  markInboundTransferBalanceConsumed,
  findX402PaytoSettlementIntent,
  listOwnAccountAddresses,
} from '../../infra/repositories/inbound-transfers.js'
import type { InboundMatchKind } from '../../infra/repositories/inbound-transfers.js'
import type { RawERC20Transfer } from '../../infra/explorer-api.js'
import {
  readInboundTransfersByTxHash,
  type ChainInboundLeg,
  type ChainReadResult,
} from './chain-read.js'
import type { Executor } from '../../infra/transaction.js'

export interface IngestInboundTransferAccount {
  id: string
  userId: string
  accountAddress: string
  chainId: number
}

/**
 * The logger shape the ingest needs. Structural, so both the request logger
 * (`FastifyBaseLogger`) and the background-job logger (`JobLogger`) satisfy it
 * without either being widened.
 */
export interface InboundIngestLogger {
  warn: (obj: unknown, msg?: string) => void
}

/**
 * One inbound USDC leg, in the shape the index writes. Both sources produce
 * it: the explorer read (`explorerRowsToLegs`) and the chain read
 * (`chain-read.ts`). `logIndex` is null only when the source does not report
 * one.
 */
export interface InboundTransferLeg {
  txHash: string
  logIndex: number | null
  payerAddress: string
  tokenAddress: string
  amountRaw: string
  blockNumber: number | null
  blockTime: Date
}

/**
 * The asset the receive index tracks: the registry's USDC asset, identified by
 * its registry ADDRESS per chain — never by a symbol string. Gnosis's bridged
 * asset is 'USDC.e', which the old dot-stripped symbol test silently excluded
 * (`'USDCE' !== 'USDC'`), so no Gnosis leg ever persisted (#3333 round-2
 * finding F-1). A contract that merely NAMED itself USDC is not the
 * settlement asset; the registry entry is.
 */
function isSettlementToken(chainId: number, contractAddress: string): boolean {
  const settlement = settlementTokenForChain(chainId)
  return settlement?.address?.toLowerCase() === contractAddress.toLowerCase()
}

/**
 * A zero-value transfer is not a payment (#4903). It is left out for EVERY
 * account, not only merchant accounts: the ingest and the row identity are
 * shared, so a filter that applied to one kind of account would make the same
 * transaction index differently depending on who owns the account.
 */
function isZeroAmountRaw(value: string): boolean {
  return /^0+$/.test(value)
}

/**
 * The explorer rows one read produced, filtered to the legs this index tracks:
 * inbound to the account, the settlement token by registry address, and a
 * non-zero amount. `logIndex` rides through when the provider reports it
 * (Blockscout v2 does; Alchemy's transfers API does not).
 */
export function explorerRowsToLegs(
  account: IngestInboundTransferAccount,
  rows: RawERC20Transfer[],
): InboundTransferLeg[] {
  const addrLower = account.accountAddress.toLowerCase()
  const legs: InboundTransferLeg[] = []
  for (const tx of rows) {
    if (tx.to.toLowerCase() !== addrLower) continue
    if (!isSettlementToken(account.chainId, tx.contractAddress)) continue
    if (isZeroAmountRaw(tx.value)) continue

    // Explorer timestamps are unix seconds; the column is TIMESTAMPTZ.
    const seconds = Number.parseInt(tx.timeStamp, 10)
    legs.push({
      txHash: tx.hash,
      logIndex: typeof tx.logIndex === 'number' ? tx.logIndex : null,
      payerAddress: tx.from,
      tokenAddress: tx.contractAddress,
      amountRaw: tx.value,
      blockNumber: Number.parseInt(tx.blockNumber, 10) || null,
      blockTime: Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(),
    })
  }
  return legs
}

/**
 * Ingest the inbound legs one read produced. Returns how many rows were newly
 * indexed (an adopted pre-migration row counts as already indexed).
 *
 * `sender_is_own_address` is decided HERE, at index time (#4903): the owner's
 * own addresses are resolved once per pass and each leg is stamped with
 * whether its payer is one of them. Recording it now means a later change to
 * the owner's account set cannot rewrite history.
 */
export async function ingestInboundTransfers(
  account: IngestInboundTransferAccount,
  legs: InboundTransferLeg[],
  log: InboundIngestLogger,
): Promise<number> {
  if (!account.userId || !account.accountAddress) return 0
  if (legs.length === 0) return 0

  let ownAddresses: Set<string>
  try {
    ownAddresses = new Set(await listOwnAccountAddresses(account.userId))
  } catch (err) {
    // The flag is a recorded fact, not a gate: a failed lookup leaves it false
    // rather than dropping the payment from the index.
    log.warn({ err, accountId: account.id }, 'Own-address lookup failed for inbound ingest')
    ownAddresses = new Set()
  }

  let inserted = 0
  for (const leg of legs) {
    try {
      const id = await insertInboundTransfer({
        accountId: account.id,
        userId: account.userId,
        chainId: account.chainId,
        txHash: leg.txHash,
        logIndex: leg.logIndex,
        payerAddress: leg.payerAddress,
        tokenAddress: leg.tokenAddress,
        amountRaw: leg.amountRaw,
        blockNumber: leg.blockNumber,
        blockTime: leg.blockTime,
        senderIsOwnAddress: ownAddresses.has(leg.payerAddress.toLowerCase()),
      })
      if (id) inserted += 1
    } catch (err) {
      // Ingestion is best-effort bookkeeping beside the live read: a failed
      // row is logged and skipped, never a failed transaction feed.
      log.warn(
        { err, accountId: account.id, chainId: account.chainId, txHash: leg.txHash },
        'Inbound transfer ingest failed',
      )
    }
  }

  return inserted
}

/**
 * One transaction by hash, read from the chain (#4903): the USDC transfers to
 * the account, or none. `ok: false` means the chain could not be read — never
 * "there is none". Nothing here comes from a caller.
 */
export async function readInboundTransferByTxHash(input: {
  chainId: number
  accountAddress: string
  txHash: string
}): Promise<ChainReadResult> {
  return readInboundTransfersByTxHash(input.chainId, input.accountAddress, input.txHash)
}

/** A transaction hash: 32 bytes, no checksummed form. */
export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

/**
 * The body fields the ingest route refuses. The chain is the only source of a
 * transfer's facts, so a caller naming any of them is refused rather than
 * silently ignored — otherwise it could believe it planted a row.
 */
const INGEST_CALLER_SUPPLIED_FIELDS = [
  'payer_address',
  'amount_raw',
  'token_address',
  'block_time',
  'block_number',
] as const

export type IngestByTxHashResult =
  | { ok: true; value: { ingested: boolean; legs_indexed: number; tx_hash: string } }
  | { ok: false; failure: { status: 400 | 404 | 503; error: string } }

/**
 * The whole chain-verified ingest (#4903), so the route stays a thin shell:
 * refuse a caller's description of the transfer, read the transaction from the
 * chain, index the settlement-token legs to the account. The failure statuses
 * are decided HERE, where the cause is known — never re-derived from message
 * text at the route.
 */
export async function ingestInboundTransferByTxHash(input: {
  account: IngestInboundTransferAccount
  body: Record<string, unknown>
  log: InboundIngestLogger
}): Promise<IngestByTxHashResult> {
  const supplied = INGEST_CALLER_SUPPLIED_FIELDS.filter(
    (field) => input.body[field] !== undefined,
  )
  if (supplied.length > 0) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: `The ingest route reads the chain: it takes only tx_hash. ${supplied.join(', ')} not accepted.`,
      },
    }
  }

  const rawHash = input.body.tx_hash
  const txHash =
    typeof rawHash === 'string' && TX_HASH_PATTERN.test(rawHash) ? rawHash : null
  if (!txHash) {
    return { ok: false, failure: { status: 400, error: 'tx_hash is required' } }
  }

  const read = await readInboundTransfersByTxHash(
    input.account.chainId,
    input.account.accountAddress,
    txHash,
  )
  if (!read.ok) {
    // An RPC outage is "not known yet", never "this transaction did not pay
    // you": nothing is written and the caller may retry.
    return {
      ok: false,
      failure: { status: 503, error: 'The chain could not be read; nothing was indexed' },
    }
  }
  if (read.legs.length === 0) {
    return {
      ok: false,
      failure: { status: 404, error: 'No USDC transfer to this account in that transaction' },
    }
  }

  const indexed = await ingestInboundTransfers(input.account, read.legs, input.log)
  return { ok: true, value: { ingested: indexed > 0, legs_indexed: indexed, tx_hash: txHash } }
}

/** Re-exported so callers of the module do not reach into `chain-read.ts`. */
export type { ChainInboundLeg, ChainReadResult }

export interface ReceiptDrop {
  /** The on-chain transaction the receipt is for — the match key. */
  txHash: string
  /** The merchant receipt document (already validated/captured upstream). */
  receiptId: string | null
}

export type InboundMatchResult =
  | { ok: true; matchKind: InboundMatchKind; transferId: string }
  | { ok: false; failure: { status: 404 | 409; error: string } }

/**
 * Match ONE inbound row for `accountId`. Resolution order is the issue's:
 * an x402 settlement the account was payTo for (resolved by tx hash through
 * `findX402PaytoSettlement`), else the supplied receipt. The receipt shape is
 * `{ receiptId }` — the document reference, supplied by the caller after its
 * own validation (the public drop route validates the signature; the agent
 * route reuses the #956 capture).
 */
export async function matchInboundTransferForAccount(
  input: {
    accountId: string
    userId: string
    /** The receiving account's address — the payTo the settlement must name. */
    accountAddress: string
    txHash: string
    receiptId?: string | null
    /**
     * The recovered drop signer, when the caller is the receipt drop: the
     * row must name THIS payer, so a drop never lands on another payer's leg
     * of the same hash. Null (the owner-supplied path) skips the filter.
     */
    payerAddress?: string | null
    /**
     * When supplied (the payer's receipt drop carries its amount), the
     * persisted row's amount must EQUAL it before a `receipt` match is
     * written. The transfer is the ground truth — a document that names a
     * different amount does not describe this transfer, and linking it
     * would let a contradicting document stand as the row's earned evidence.
     */
    expectedAmountRaw?: string | null
    /**
     * Optional executor for transactional threading; when omitted the
     * repository's own pool default applies (the pool lives behind
     * `infra/repositories/` — `pg-only-in-infra`).
     */
    db?: Executor
  },
): Promise<InboundMatchResult> {
  const row = await findUnmatchedByTxHash(
    input.accountId,
    input.userId,
    input.txHash,
    input.payerAddress ?? null,
    input.db,
  )
  if (!row) {
    return {
      ok: false,
      failure: { status: 404, error: 'No unmatched inbound transfer for that tx hash' },
    }
  }

  if (input.expectedAmountRaw != null && input.expectedAmountRaw !== row.amount_raw) {
    return {
      ok: false,
      // 409: the row exists but the document contradicts it (amount). The
      // STATUS is decided here, where the cause is known — never re-derived
      // from message text at the route.
      failure: {
        status: 409,
        error: `amount mismatch: drop names ${input.expectedAmountRaw}, transfer carries ${row.amount_raw}`,
      },
    }
  }

  const settlement = await findX402PaytoSettlement(
    {
      accountId: input.accountId,
      userId: input.userId,
      accountAddress: input.accountAddress,
      chainId: row.chain_id,
      txHash: input.txHash,
      db: input.db,
    },
  )
  if (settlement) {
    const matched = await matchInboundTransfer(
      {
        transferId: row.id,
        userId: input.userId,
        matchKind: 'x402_payto',
        matchedReceiptId: input.receiptId ?? null,
        matchedPaymentIntentId: settlement,
      },
      input.db,
    )
    if (matched) {
      // A matched transfer is EARNED: it now counts in the receive balance.
      // The flag write is part of the match outcome, not best-effort: a
      // failure propagates so the caller never reports a match whose amount
      // the balance would silently understate.
      await markInboundTransferBalanceConsumed(row.id, input.userId, input.db)
      return { ok: true, matchKind: 'x402_payto', transferId: row.id }
    }
  }

  if (input.receiptId) {
    const matched = await matchInboundTransfer(
      {
        transferId: row.id,
        userId: input.userId,
        matchKind: 'receipt',
        matchedReceiptId: input.receiptId,
        matchedPaymentIntentId: null,
      },
      input.db,
    )
    if (matched) {
      await markInboundTransferBalanceConsumed(row.id, input.userId, input.db)
      return { ok: true, matchKind: 'receipt', transferId: row.id }
    }
  }

  return {
    ok: false,
    failure: {
      status: 404,
      error: 'Nothing to match against — supply a receipt the transfer was paid for',
    },
  }
}

/**
 * The x402-payTo half of the match: is there a CONFIRMED x402 settlement
 * whose `payTo` is THIS account's address and whose transaction hash is the
 * inbound row's? The lookup itself lives in the repository
 * (`findX402PaytoSettlementIntent`); this wrapper keeps the module's public
 * shape for the matcher and its tests.
 *
 * Cross-user by construction, and kept read-only: the matched intent id is
 * stored on the inbound row for audit but is never served to the receiver —
 * the wire carries only `match_kind`. No authority is involved: the link
 * records that the payer's settlement names the same on-chain event the
 * account already sees, nothing more.
 */
export async function findX402PaytoSettlement(input: {
  accountId: string
  userId: string
  accountAddress: string
  chainId: number
  txHash: string
  db?: Executor
}): Promise<string | null> {
  return findX402PaytoSettlementIntent({
    accountId: input.accountId,
    userId: input.userId,
    accountAddress: input.accountAddress,
    chainId: input.chainId,
    txHash: input.txHash,
    db: input.db,
  })
}
