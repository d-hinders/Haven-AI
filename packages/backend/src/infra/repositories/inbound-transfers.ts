/**
 * Repository for the persisted inbound-transfer index (#3333, epic #3328).
 *
 * Payment-adjacent SQL lives here by rule (`docs/regulatory/casp-risk-guardrails.md`
 * merge checklist: routes and libs hold control flow only). Every statement is
 * user-scoped — `user_id` is a required parameter or a join through
 * `smart_accounts` — so an account's receive index is never readable through
 * another account's id.
 *
 * The index is written by ingestion (idempotent upsert on chain+hash+account)
 * and by the matcher (a one-way link: set once, never overwritten). No statement here
 * moves money, holds a key, or grants authority — a matched receipt is a
 * document reference, and the off-ramp hand-off is the owner's own signed
 * transfer (`rails/hybrid-transfers.ts`), which this file never touches.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export interface InboundTransferRow {
  id: string
  account_id: string
  user_id: string
  chain_id: number
  tx_hash: string
  log_index: number | null
  payer_address: string
  token_address: string
  amount_raw: string
  block_number: number | null
  block_time: Date
  match_kind: InboundMatchKind | null
  matched_receipt_id: string | null
  matched_payment_intent_id: string | null
  balance_consumed: boolean
}

/** How the row was linked to evidence — the two shapes #3333 names, keyed on the tx hash. */
export type InboundMatchKind = 'x402_payto' | 'receipt'

export interface InsertInboundTransferInput {
  accountId: string
  userId: string
  chainId: number
  txHash: string
  logIndex?: number | null
  payerAddress: string
  tokenAddress: string
  amountRaw: string
  blockNumber?: number | null
  blockTime: Date
}

const INSERT_INGEST_SQL = `
  INSERT INTO inbound_transfers (
    account_id, user_id, chain_id, tx_hash, log_index,
    payer_address, token_address, amount_raw, block_number, block_time
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (chain_id, LOWER(tx_hash), account_id) DO NOTHING
  RETURNING id`

/**
 * Idempotent ingest: the unique index on (chain_id, LOWER(tx_hash), account_id)
 * is the dedupe, so re-reading an explorer window cannot double-count an
 * inbound payment — while one tx paying two accounts still lands one row per
 * receiving account (round-2 F-2; the old chain+hash key silently deleted the
 * second account's row). Returns the row id; `null` means the transfer was
 * already indexed for THIS account.
 */
export async function insertInboundTransfer(
  input: InsertInboundTransferInput,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(INSERT_INGEST_SQL, [
    input.accountId,
    input.userId,
    input.chainId,
    input.txHash,
    input.logIndex ?? null,
    input.payerAddress.toLowerCase(),
    input.tokenAddress.toLowerCase(),
    input.amountRaw,
    input.blockNumber ?? null,
    input.blockTime,
  ])
  return result.rows[0]?.id ?? null
}

/** The account's owner (users.id), for the ingest pass that scopes rows to a user. */
export async function findOwnerUserIdForAccount(accountId: string): Promise<string | null> {
  const result = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM smart_accounts WHERE id = $1',
    [accountId],
  )
  return result.rows[0]?.user_id ?? null
}

/**
 * The receiving account behind (address, chain) — the receipt drop's target.
 * The drop arrives with no caller identity (the payer is not a Haven user),
 * so the account is resolved from the transfer's own receiving address. The
 * `user_id` comes back WITH the id: every subsequent write on the row is
 * scoped to that owner, never to a caller-supplied one.
 */
export async function findAccountIdByAddressAndChain(
  accountAddress: string,
  chainId: number,
): Promise<{ accountId: string; userId: string } | null> {
  const result = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM smart_accounts
      WHERE LOWER(account_address) = LOWER($1)
        AND chain_id = $2
      LIMIT 1`,
    [accountAddress, chainId],
  )
  const row = result.rows[0]
  return row ? { accountId: row.id, userId: row.user_id } : null
}

const MARK_BALANCE_CONSUMED_SQL = `
  UPDATE inbound_transfers
     SET balance_consumed = true,
         updated_at = NOW()
   WHERE id = $1
     AND user_id = $2
     AND balance_consumed = false
  RETURNING id`

/**
 * Count a row in the receive balance. Called when the row's match lands —
 * a matched transfer is EARNED, an unmatched one is not (#3333: "unmatched
 * inbound rows are flagged as unearned until matched"). The WHERE refuses a
 * re-count: the balance is a SUM over `balance_consumed` rows, so setting the
 * flag twice is harmless today, but the guard keeps the write one-way like
 * every other state change on this table.
 */
export async function markInboundTransferBalanceConsumed(
  transferId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(MARK_BALANCE_CONSUMED_SQL, [transferId, userId])
  return result.rowCount === 1
}

const FIND_UNMATCHED_FOR_ACCOUNT_SQL = `
  SELECT id, account_id, user_id, chain_id, tx_hash, log_index,
         payer_address, token_address, amount_raw, block_number, block_time,
         match_kind, matched_receipt_id, matched_payment_intent_id,
         balance_consumed
    FROM inbound_transfers
   WHERE account_id = $1
     AND user_id = $2
     AND match_kind IS NULL
   ORDER BY block_time DESC`

/** The account's unmatched (unearned) rows — the matcher's worklist. User-scoped. */
export async function findUnmatchedInboundTransfers(
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<InboundTransferRow[]> {
  const result = await db.query<InboundTransferRow>(FIND_UNMATCHED_FOR_ACCOUNT_SQL, [
    accountId,
    userId,
  ])
  return result.rows
}

/**
 * Match by the #3333 key — the transaction hash. Finds the newest UNMATCHED
 * row on this account whose hash equals the given one (case-insensitive; the
 * index lowercases, hashes have no checksum). `payerAddress` further pins the
 * row to one payer — the receipt drop path passes the signer it recovered, so
 * a drop can never land on another payer's leg of the same hash. Returns null
 * when every row for that key is already matched: one inbound payment links
 * to ONE settlement — a second receipt for the same hash finds nothing to
 * link.
 */
export async function findUnmatchedByTxHash(
  accountId: string,
  userId: string,
  txHash: string,
  payerAddress?: string | null,
  db: Executor = pool,
): Promise<InboundTransferRow | null> {
  const result = await db.query<InboundTransferRow>(
    `
    SELECT id, account_id, user_id, chain_id, tx_hash, log_index,
           payer_address, token_address, amount_raw, block_number, block_time,
           match_kind, matched_receipt_id, matched_payment_intent_id,
           balance_consumed
      FROM inbound_transfers
     WHERE account_id = $1
       AND user_id = $2
       AND LOWER(tx_hash) = LOWER($3)
       AND ($4::text IS NULL OR payer_address = LOWER($4))
       AND match_kind IS NULL
     ORDER BY block_time DESC
     LIMIT 1`,
    [accountId, userId, txHash, payerAddress ?? null],
  )
  return result.rows[0] ?? null
}

const MATCH_ROW_SQL = `
  UPDATE inbound_transfers
     SET match_kind = $3,
         matched_receipt_id = $4,
         matched_payment_intent_id = $5,
         updated_at = NOW()
   WHERE id = $1
     AND user_id = $2
     AND match_kind IS NULL
   RETURNING id`

/**
 * The one-way match write. `match_kind IS NULL` is in the WHERE, so a
 * concurrent matcher loses the race cleanly rather than overwriting a link —
 * the row's match is set exactly once. `matchedPaymentIntentId` is present
 * only for `x402_payto` (the settlement the account was payTo for);
 * `matchedReceiptId` only for `receipt`.
 */
export async function matchInboundTransfer(
  input: {
    transferId: string
    userId: string
    matchKind: InboundMatchKind
    matchedReceiptId: string | null
    matchedPaymentIntentId: string | null
  },
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(MATCH_ROW_SQL, [
    input.transferId,
    input.userId,
    input.matchKind,
    input.matchedReceiptId,
    input.matchedPaymentIntentId,
  ])
  return result.rowCount === 1
}

/**
 * The receive balance: SUM of the account's matched rows, as a numeric string
 * in atomic units (NUMERIC(78,0) does not fit a JS number). Unmatched rows
 * are excluded — they are unearned, and nothing delivered on them (#3333).
 */
export async function inboundReceiveBalanceAtomic(
  accountId: string,
  userId: string,
  db: Executor = pool,
): Promise<string> {
  const result = await db.query<{ total: string | null }>(
    `
    SELECT COALESCE(SUM(amount_raw::numeric), 0)::text AS total
      FROM inbound_transfers
     WHERE account_id = $1
       AND user_id = $2
       AND balance_consumed = true`,
    [accountId, userId],
  )
  return result.rows[0]?.total ?? '0'
}

export interface InboundReceiveLedgerRow {
  id: string
  chain_id: number
  tx_hash: string
  payer_address: string
  amount_raw: string
  block_time: Date
  match_kind: InboundMatchKind | null
  matched_payment_intent_id: string | null
  matched_receipt_id: string | null
  balance_consumed: boolean
}

const LIST_LEDGER_SQL = `
  SELECT id, chain_id, tx_hash, payer_address, amount_raw, block_time,
         match_kind, matched_payment_intent_id, matched_receipt_id,
         balance_consumed
    FROM inbound_transfers
   WHERE account_id = $1
     AND user_id = $2
   ORDER BY block_time DESC
   LIMIT $3`

/** The receive ledger (newest first), for the dashboard receive panel and the transactions feed. */
export async function listInboundTransfers(
  accountId: string,
  userId: string,
  limit: number,
  db: Executor = pool,
): Promise<InboundReceiveLedgerRow[]> {
  const result = await db.query<InboundReceiveLedgerRow>(LIST_LEDGER_SQL, [
    accountId,
    userId,
    limit,
  ])
  return result.rows
}

// ── Off-ramp destinations (#3333) ────────────────────────────────────────────
// The OWNER's saved off-ramp deposit address, one per account+chain. The
// OWNER-only contract (agents have no route to these writes) lives in the
// routes and `modules/transactions/off-ramp.ts`; the rows live here with the
// rest of the receive side's payment-adjacent SQL.

export interface OffRampDestinationRow {
  id: string
  account_id: string
  chain_id: number
  destination_address: string
  destination_kind: string
  label: string | null
  created_at: Date
  updated_at: Date
}

const FIND_DESTINATION_SQL = `
  SELECT id, account_id, chain_id, destination_address, destination_kind,
         label, created_at, updated_at
    FROM off_ramp_destinations
   WHERE account_id = $1
     AND user_id = $2
     AND chain_id = $3
   LIMIT 1`

/** The owner's saved off-ramp destination for one account+chain, or null. */
export async function findOffRampDestinationRow(
  accountId: string,
  userId: string,
  chainId: number,
  db: Executor = pool,
): Promise<OffRampDestinationRow | null> {
  const result = await db.query<OffRampDestinationRow>(FIND_DESTINATION_SQL, [
    accountId,
    userId,
    chainId,
  ])
  return result.rows[0] ?? null
}

const UPSERT_DESTINATION_SQL = `
  INSERT INTO off_ramp_destinations (account_id, user_id, chain_id, destination_address, destination_kind)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (account_id, chain_id) DO UPDATE
     SET destination_address = EXCLUDED.destination_address,
         destination_kind = EXCLUDED.destination_kind,
         updated_at = NOW()
  RETURNING id, account_id, chain_id, destination_address, destination_kind,
            label, created_at, updated_at`

/** Set (or replace) the owner's off-ramp destination. Owner-scoped by caller contract. */
export async function upsertOffRampDestinationRow(input: {
  accountId: string
  userId: string
  chainId: number
  destinationAddress: string
  destinationKind: string
  db?: Executor
}): Promise<OffRampDestinationRow> {
  const db = input.db ?? pool
  const result = await db.query<OffRampDestinationRow>(UPSERT_DESTINATION_SQL, [
    input.accountId,
    input.userId,
    input.chainId,
    input.destinationAddress.toLowerCase(),
    input.destinationKind,
  ])
  return result.rows[0]
}

// ── The x402 payTo settlement lookup (#3333) ─────────────────────────────────
// Read-only evidence for the match: is there a CONFIRMED x402 settlement whose
// `payTo` is THIS account's address and whose transaction hash is the inbound
// row's? The settlement intent belongs to the PAYER (whoever's agent paid this
// account — on the same deployment that payer is another user), so the query
// is deliberately NOT scoped `pi.user_id = receiver`: the account was payTo
// FOR someone else's payment. The hash is the whole key — it names one
// on-chain event, and the payTo address test ties it to this account.

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
 * The settlement intent id the account was payTo for at this tx hash, or null.
 * Cross-user by construction and kept read-only: the matched intent id is
 * stored on the inbound row for audit but is never served to the receiver —
 * the wire carries only `match_kind`. No authority is involved.
 */
export async function findX402PaytoSettlementIntent(input: {
  accountId: string
  userId: string
  accountAddress: string
  chainId: number
  txHash: string
  db?: Executor
}): Promise<string | null> {
  const db = input.db ?? pool
  const result = await db.query<{ id: string }>(FIND_X402_PAYTO_SETTLEMENT_SQL, [
    input.accountId,
    input.accountAddress,
    input.chainId,
    input.txHash,
    input.userId,
  ])
  return result.rows[0]?.id ?? null
}

// ── The payer's signed receipt drop (#3333) ──────────────────────────────────
// One document per (chain, hash, payer); a re-drop is idempotent and a
// different signer for the same transfer is a distinct row the matcher
// refuses (it only accepts the row's own payer).

const INSERT_RECEIPT_DROP_SQL = `
  INSERT INTO inbound_receipt_drops (account_id, user_id, chain_id, tx_hash, payer_address, document)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (chain_id, LOWER(tx_hash), payer_address) DO NOTHING
  RETURNING id`

/** Persist a payer-supplied receipt document; returns its id, or null on a re-drop. */
export async function insertInboundReceiptDrop(input: {
  accountId: string
  userId: string
  chainId: number
  txHash: string
  payerAddress: string
  document: Record<string, unknown>
  db?: Executor
}): Promise<string | null> {
  const db = input.db ?? pool
  const result = await db.query<{ id: string }>(INSERT_RECEIPT_DROP_SQL, [
    input.accountId,
    input.userId,
    input.chainId,
    input.txHash,
    input.payerAddress,
    JSON.stringify(input.document),
  ])
  return result.rows[0]?.id ?? null
}
