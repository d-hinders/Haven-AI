/**
 * The receive side (#3333, epic #3328): ingest + match for the persisted
 * inbound-transfer index.
 *
 * Two entry points, both keyed on the transaction hash:
 *
 * 1. `ingestInboundTransfers` — the explorer-derived ERC-20 legs that came
 *    back INBOUND to the account's address (from `aggregate.ts`'s fetchers,
 *    read verbatim — no second explorer call) are upserted into
 *    `inbound_transfers`. USDC only: the slice's asset is the settlement
 *    token, and the ledger is a USDC receive balance, not a general token
 *    inventory. Idempotent per (chain, hash).
 *
 * 2. `matchInboundTransferForAccount` — one row is linked to its evidence,
 *    by one of exactly two match kinds the issue names:
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
import { getChain } from '../../domain/chains.js'
import {
  insertInboundTransfer,
  findUnmatchedByTxHash,
  matchInboundTransfer,
  markInboundTransferBalanceConsumed,
} from '../../infra/repositories/inbound-transfers.js'
import type { InboundMatchKind } from '../../infra/repositories/inbound-transfers.js'
import type { RawERC20Transfer } from '../../infra/explorer-api.js'
import type { FastifyBaseLogger } from 'fastify'
import pool from '../../db.js'
import { type Executor } from '../../infra/transaction.js'

export interface IngestInboundTransferAccount {
  id: string
  userId: string
  accountAddress: string
  chainId: number
}

/** The asset the receive index tracks: USDC (by chain-registry symbol). */
function isUsdcSymbol(symbol: string): boolean {
  return symbol.toUpperCase().replace('.', '') === 'USDC'
}

/**
 * Ingest the inbound ERC-20 legs one explorer read produced. `rows` is the
 * RAW transfer list exactly as `aggregate.ts` received it (the caller passes
 * its own fetched leg through) — no second explorer call, no changed read.
 * Returns how many rows were newly indexed.
 */
export async function ingestInboundTransfers(
  account: IngestInboundTransferAccount,
  rows: RawERC20Transfer[],
  log: FastifyBaseLogger,
): Promise<number> {
  const chain = getChain(account.chainId)
  const addrLower = account.accountAddress.toLowerCase()
  if (!account.userId || !addrLower) return 0
  let inserted = 0

  for (const tx of rows) {
    const toLower = tx.to.toLowerCase()
    if (toLower !== addrLower) continue

    const knownToken = chain.tokenByAddress[tx.contractAddress.toLowerCase()]
    const symbol = knownToken?.symbol ?? tx.tokenSymbol ?? ''
    if (!isUsdcSymbol(symbol)) continue

    // Explorer timestamps are unix seconds; the column is TIMESTAMPTZ.
    const seconds = Number.parseInt(tx.timeStamp, 10)
    const blockTime = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date()

    try {
      const id = await insertInboundTransfer({
        accountId: account.id,
        userId: account.userId,
        chainId: account.chainId,
        txHash: tx.hash,
        payerAddress: tx.from,
        tokenAddress: tx.contractAddress,
        amountRaw: tx.value,
        blockNumber: Number.parseInt(tx.blockNumber, 10) || null,
        blockTime,
      })
      if (id) inserted += 1
    } catch (err) {
      // Ingestion is best-effort bookkeeping beside the live read: a failed
      // row is logged and skipped, never a failed transaction feed.
      log.warn(
        { err, accountId: account.id, chainId: account.chainId, txHash: tx.hash },
        'Inbound transfer ingest failed',
      )
    }
  }

  return inserted
}

export interface ReceiptDrop {
  /** The on-chain transaction the receipt is for — the match key. */
  txHash: string
  /** The merchant receipt document (already validated/captured upstream). */
  receiptId: string | null
}

export type InboundMatchResult =
  | { ok: true; matchKind: InboundMatchKind; transferId: string }
  | { ok: false; error: string }

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
  },
  db: Executor = pool,
): Promise<InboundMatchResult> {
  const row = await findUnmatchedByTxHash(
    input.accountId,
    input.userId,
    input.txHash,
    input.payerAddress ?? null,
    db,
  )
  if (!row) {
    return { ok: false, error: 'No unmatched inbound transfer for that tx hash' }
  }

  if (input.expectedAmountRaw != null && input.expectedAmountRaw !== row.amount_raw) {
    return { ok: false, error: `amount mismatch: drop names ${input.expectedAmountRaw}, transfer carries ${row.amount_raw}` }
  }

  const settlement = await findX402PaytoSettlement(
    {
      accountId: input.accountId,
      userId: input.userId,
      accountAddress: input.accountAddress,
      chainId: row.chain_id,
      txHash: input.txHash,
    },
    db,
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
      db,
    )
    if (matched) {
      // A matched transfer is EARNED: it now counts in the receive balance.
      // The flag write is part of the match outcome, not best-effort: a
      // failure propagates so the caller never reports a match whose amount
      // the balance would silently understate.
      await markInboundTransferBalanceConsumed(row.id, input.userId, db)
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
      db,
    )
    if (matched) {
      await markInboundTransferBalanceConsumed(row.id, input.userId, db)
      return { ok: true, matchKind: 'receipt', transferId: row.id }
    }
  }

  return { ok: false, error: 'Nothing to match against — supply a receipt the transfer was paid for' }
}

const FIND_X402_PAYTO_SETTLEMENT_SQL = `
  SELECT pi.id
    FROM payment_intents pi
   WHERE pi.source = 'x402'
     AND pi.status = 'confirmed'
     AND pi.tx_hash IS NOT NULL
     AND pi.chain_id IS NOT NULL
     AND pi.chain_id = $3
     AND (LOWER(pi.to_address) = LOWER($2)
          OR LOWER(COALESCE(pi.x402_merchant_address, '')) = LOWER($2))
     AND LOWER(pi.tx_hash) = LOWER($4)
     AND EXISTS (
       SELECT 1 FROM smart_accounts sa
        WHERE sa.id = $1
          AND sa.user_id = $5
          AND LOWER(sa.account_address) = LOWER($2)
          AND sa.chain_id = pi.chain_id
     )
   LIMIT 1`

/**
 * The x402-payTo half of the match: is there a CONFIRMED x402 settlement
 * whose `payTo` is THIS account's address and whose transaction hash is the
 * inbound row's? The settlement intent belongs to the PAYER (whoever's agent
 * paid this account — on the same deployment that payer is another user), so
 * the query is deliberately NOT scoped `pi.user_id = receiver`: the account
 * was payTo FOR someone else's payment. The hash is the whole key — it names
 * one on-chain event, and the payTo address test ties it to this account.
 *
 * Cross-user by construction, and kept read-only: the matched intent id is
 * stored on the inbound row for audit but is never served to the receiver —
 * the wire carries only `match_kind`. No authority is involved: the link
 * records that the payer's settlement names the same on-chain event the
 * account already sees, nothing more.
 */
export async function findX402PaytoSettlement(
  input: {
    accountId: string
    userId: string
    accountAddress: string
    chainId: number
    txHash: string
  },
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(FIND_X402_PAYTO_SETTLEMENT_SQL, [
    input.accountId,
    input.accountAddress,
    input.chainId,
    input.txHash,
    input.userId,
  ])
  return result.rows[0]?.id ?? null
}
