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
  /** Decided at index time (#4903): the payer is one of the owner's own addresses. */
  sender_is_own_address: boolean
}

/** How the row was linked to evidence — the two shapes #3333 names, keyed on the tx hash. */
export type InboundMatchKind = 'x402_payto' | 'receipt'

export interface InsertInboundTransferInput {
  accountId: string
  userId: string
  chainId: number
  txHash: string
  /**
   * The transfer's log index — the on-chain half of its identity (#4903).
   * `null` when the source does not report one (Alchemy's transfers API, and
   * every row written before migration 128); the unknown-case unique index
   * then dedupes on (chain, hash, account, payer, amount), and the mirror
   * guard refuses the leg outright when a known-index row for it already
   * exists (round-2 F-1).
   */
  logIndex?: number | null
  payerAddress: string
  tokenAddress: string
  amountRaw: string
  blockNumber?: number | null
  blockTime: Date
  /** Whether the payer is one of the owner's own addresses, decided HERE (#4903). */
  senderIsOwnAddress?: boolean
}

/**
 * The known-log-index insert (#4903). The conflict target names the partial
 * unique index and repeats its predicate, which is how Postgres infers a
 * partial index from `ON CONFLICT`.
 */
const INSERT_LEG_SQL = `
  INSERT INTO inbound_transfers (
    account_id, user_id, chain_id, tx_hash, log_index,
    payer_address, token_address, amount_raw, block_number, block_time,
    sender_is_own_address
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (chain_id, LOWER(tx_hash), account_id, log_index) WHERE log_index IS NOT NULL
  DO NOTHING
  RETURNING id`

/**
 * The unknown-log-index insert (#4903). Same leg re-read → conflict; a second
 * leg of the same transaction → a distinct row, because it differs in payer or
 * amount.
 *
 * ## The mirror guard (round-2 F-1)
 *
 * The two partial unique indexes are DISJOINT: a row with `log_index = 3` is
 * invisible to the unknown-case index, so an explorer read that reports no log
 * index would insert a SECOND row for a leg the chain pass already indexed.
 * That is the normal merchant sequence — the 5-minute pass writes the leg with
 * its log index, then the owner opens the dashboard and the explorer read
 * (Alchemy reports no log index) writes it again.
 *
 * A partial index cannot span both cases, so the guard is an explicit
 * `WHERE NOT EXISTS` folded into the INSERT itself: one statement, one round
 * trip, and atomic against every row already committed. It is the exact mirror
 * of `ADOPT_UNKNOWN_LEG_SQL` — same key (chain, hash, account, payer, amount),
 * opposite direction. Two byte-identical legs of one transaction are
 * indistinguishable to a source that reports no log index, so skipping the
 * second is the honest outcome; the chain reader (which always has the log
 * index) separates them.
 *
 * The residual window is a concurrent chain-pass insert of the SAME leg
 * committing between this statement's snapshot and its own: both writers would
 * pass their guards. Closing that needs serializable isolation or a lock on a
 * row that does not exist yet; the window is milliseconds and the next chain
 * pass cannot re-read the block (the cursor has advanced), so it is recorded as
 * residual risk rather than paid for on every insert.
 */
const INSERT_UNKNOWN_LEG_SQL = `
  INSERT INTO inbound_transfers (
    account_id, user_id, chain_id, tx_hash, log_index,
    payer_address, token_address, amount_raw, block_number, block_time,
    sender_is_own_address
  )
  SELECT $1::uuid, $2::uuid, $3::integer, $4::varchar, NULL::integer,
         $5::varchar, $6::varchar, $7::varchar, $8::bigint, $9::timestamptz,
         $10::boolean
   WHERE NOT EXISTS (
     SELECT 1
       FROM inbound_transfers known
      WHERE known.account_id = $1::uuid
        AND known.chain_id = $3::integer
        AND LOWER(known.tx_hash) = LOWER($4::varchar)
        AND LOWER(known.payer_address) = LOWER($5::varchar)
        AND known.amount_raw = $7::varchar
        AND known.log_index IS NOT NULL
   )
  ON CONFLICT (chain_id, LOWER(tx_hash), account_id, payer_address, amount_raw) WHERE log_index IS NULL
  DO NOTHING
  RETURNING id`

/**
 * The reconcile rule (#4903): a leg whose log index is now known ADOPTS the
 * unknown row the old identity wrote from that same leg — same chain, hash,
 * account, payer and amount — by filling in its `log_index`. The adopted row
 * keeps its amount, its match and its `balance_consumed` flag, so the receive
 * balance does not move. `log_index IS NULL` in the WHERE makes the adoption
 * one-way and race-safe: two replicas cannot both adopt the same row.
 *
 * The `NOT EXISTS` on the known-case identity is the defensive half of the
 * round-2 F-1 fix: if a duplicate unknown row already exists for a leg whose
 * known-index row is present (a row written before the mirror guard, or the
 * millisecond race the guard cannot close), adopting it would violate
 * `idx_inbound_transfers_chain_hash_account_log` and fail the whole ingest
 * pass for that account — every tick, forever, because the cursor never
 * advances. Skipping the adoption instead lets the known-index INSERT below
 * hit its own conflict and return null: no crash, no second row.
 */
const ADOPT_UNKNOWN_LEG_SQL = `
  UPDATE inbound_transfers
     SET log_index = $5,
         sender_is_own_address = $6,
         updated_at = NOW()
   WHERE account_id = $1
     AND user_id = $2
     AND chain_id = $3
     AND LOWER(tx_hash) = LOWER($4)
     AND payer_address = LOWER($7)
     AND amount_raw = $8
     AND log_index IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM inbound_transfers known
        WHERE known.account_id = $1
          AND known.chain_id = $3
          AND LOWER(known.tx_hash) = LOWER($4)
          AND known.log_index = $5
     )
  RETURNING id`

/**
 * Idempotent ingest (#3333, identity widened by #4903). Returns the new row's
 * id; `null` means this leg was already indexed for THIS account — either it
 * conflicted on the identity, it adopted a pre-migration row that had no log
 * index, or (round-2 F-1) the unknown-log-index leg was skipped because a
 * known-index row for the same leg already exists.
 *
 * One transaction paying two accounts still lands one row per receiving
 * account (round-2 F-2), and one transaction carrying several USDC legs to the
 * same account now lands one row per LEG instead of collapsing them.
 */
export async function insertInboundTransfer(
  input: InsertInboundTransferInput,
  db: Executor = pool,
): Promise<string | null> {
  const logIndex = input.logIndex ?? null
  const senderIsOwnAddress = input.senderIsOwnAddress ?? false

  if (logIndex !== null) {
    const adopted = await db.query<{ id: string }>(ADOPT_UNKNOWN_LEG_SQL, [
      input.accountId,
      input.userId,
      input.chainId,
      input.txHash,
      logIndex,
      senderIsOwnAddress,
      input.payerAddress,
      input.amountRaw,
    ])
    if (adopted.rowCount === 1) return null

    const result = await db.query<{ id: string }>(INSERT_LEG_SQL, [
      input.accountId,
      input.userId,
      input.chainId,
      input.txHash,
      logIndex,
      input.payerAddress.toLowerCase(),
      input.tokenAddress.toLowerCase(),
      input.amountRaw,
      input.blockNumber ?? null,
      input.blockTime,
      senderIsOwnAddress,
    ])
    return result.rows[0]?.id ?? null
  }

  const result = await db.query<{ id: string }>(INSERT_UNKNOWN_LEG_SQL, [
    input.accountId,
    input.userId,
    input.chainId,
    input.txHash,
    input.payerAddress.toLowerCase(),
    input.tokenAddress.toLowerCase(),
    input.amountRaw,
    input.blockNumber ?? null,
    input.blockTime,
    senderIsOwnAddress,
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

// ── The scheduled merchant index (#4903) ─────────────────────────────────────

export interface MerchantAccountRow {
  accountId: string
  userId: string
  accountAddress: string
  chainId: number
  createdAt: Date
}

/**
 * Every account marked as a merchant account (#4895's marker), with the owner
 * and the chain the pass must read. Deliberately NOT filtered by
 * `merchant_service_settings.enabled`: indexing continues while merchant
 * services are turned off, so the account's history stays complete (#4903).
 */
export async function listMerchantAccounts(db: Executor = pool): Promise<MerchantAccountRow[]> {
  const result = await db.query<{
    account_id: string
    user_id: string
    account_address: string
    chain_id: number
    created_at: Date
  }>(
    `SELECT id AS account_id, user_id, account_address, chain_id, created_at
       FROM smart_accounts
      WHERE is_merchant_account = true
      ORDER BY created_at ASC`,
  )
  return result.rows.map((row) => ({
    accountId: row.account_id,
    userId: row.user_id,
    accountAddress: row.account_address,
    chainId: row.chain_id,
    createdAt: row.created_at,
  }))
}

export interface InboundIndexCursor {
  chainId: number
  /** The highest block the pass has fully indexed. */
  lastIndexedBlock: number
}

/** The account's index cursor, or null when the pass has never run for it. */
export async function findInboundIndexCursor(
  accountId: string,
  db: Executor = pool,
): Promise<InboundIndexCursor | null> {
  const result = await db.query<{ chain_id: number; last_indexed_block: string }>(
    `SELECT chain_id, last_indexed_block
       FROM inbound_index_cursors
      WHERE account_id = $1`,
    [accountId],
  )
  const row = result.rows[0]
  if (!row) return null
  return { chainId: row.chain_id, lastIndexedBlock: Number(row.last_indexed_block) }
}

/**
 * Advance the account's cursor. Monotonic: a pass that finishes out of order
 * (two replicas, one slower) can never move the cursor BACKWARDS and make the
 * next pass re-read a range it already covered.
 */
export async function upsertInboundIndexCursor(
  input: { accountId: string; chainId: number; lastIndexedBlock: number },
  db: Executor = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO inbound_index_cursors (account_id, chain_id, last_indexed_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE
        SET last_indexed_block = GREATEST(inbound_index_cursors.last_indexed_block, EXCLUDED.last_indexed_block),
            chain_id = EXCLUDED.chain_id,
            updated_at = NOW()`,
    [input.accountId, input.chainId, input.lastIndexedBlock],
  )
}

/**
 * The owner's own addresses — the set `sender_is_own_address` is decided
 * against at index time (#4903), and the set a merchant sale's own-sender
 * accounting uses (#4897), so the two can never disagree.
 *
 * Widened by #4897 (owner decision, 2026-11-16) from smart accounts alone to:
 * every `smart_accounts.account_address` of the user on any network, every
 * `agents.delegate_address` of the user's agents (revoked agents included —
 * the status is deliberately not filtered), and every
 * `agent_rekeys.old_delegate_address` of those agents (a key replaced by
 * rotation is no longer on the agent row but is still the owner's). All
 * lower-case, one query, de-duplicated. It intentionally changes the flag for
 * newly indexed rows of every account; rows already indexed keep what they
 * recorded, so a later account or rotation never rewrites past revenue.
 */
export async function listOwnAccountAddresses(
  userId: string,
  db: Executor = pool,
): Promise<string[]> {
  const result = await db.query<{ address: string }>(
    `SELECT LOWER(account_address) AS address
       FROM smart_accounts
      WHERE user_id = $1
     UNION
     SELECT LOWER(delegate_address)
       FROM agents
      WHERE user_id = $1
        AND delegate_address IS NOT NULL
     UNION
     SELECT LOWER(r.old_delegate_address)
       FROM agent_rekeys r
       JOIN agents a ON a.id = r.agent_id
      WHERE a.user_id = $1`,
    [userId],
  )
  return result.rows.map((row) => row.address)
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
         balance_consumed, sender_is_own_address
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
 *
 * ## The already-matched guard (round-2 F-1)
 *
 * The `NOT EXISTS` refuses a row whose (chain, hash, account, payer, amount)
 * leg is ALREADY matched. Without it, a duplicate row — the chain-first /
 * explorer-after shape F-1 found, or one written before the mirror guard —
 * would be matched by a replayed receipt drop: `receive.ts` runs the
 * `x402_payto` branch before the `receiptId` check, so the replay would find
 * the second row, match it, and `markInboundTransferBalanceConsumed` would
 * count the same on-chain transfer twice in `inboundReceiveBalanceAtomic`.
 * With the guard the replay finds nothing (404, the documented "every row for
 * that key is already matched"), and the balance cannot move.
 *
 * The key deliberately includes `amount_raw`: two legs of one transaction with
 * DIFFERENT amounts are distinct payments and stay independently matchable.
 * Two byte-identical legs are indistinguishable from any evidence a drop can
 * carry, so matching one is the honest outcome.
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
    SELECT t.id, t.account_id, t.user_id, t.chain_id, t.tx_hash, t.log_index,
           t.payer_address, t.token_address, t.amount_raw, t.block_number, t.block_time,
           t.match_kind, t.matched_receipt_id, t.matched_payment_intent_id,
           t.balance_consumed, t.sender_is_own_address
      FROM inbound_transfers t
     WHERE t.account_id = $1
       AND t.user_id = $2
       AND LOWER(t.tx_hash) = LOWER($3)
       AND ($4::text IS NULL OR t.payer_address = LOWER($4))
       AND t.match_kind IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM inbound_transfers m
          WHERE m.account_id = t.account_id
            AND m.chain_id = t.chain_id
            AND LOWER(m.tx_hash) = LOWER(t.tx_hash)
            AND m.payer_address = t.payer_address
            AND m.amount_raw = t.amount_raw
            AND m.match_kind IS NOT NULL
       )
     ORDER BY t.block_time DESC
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
  log_index: number | null
  payer_address: string
  amount_raw: string
  block_time: Date
  match_kind: InboundMatchKind | null
  matched_payment_intent_id: string | null
  matched_receipt_id: string | null
  balance_consumed: boolean
  sender_is_own_address: boolean
}

const LIST_LEDGER_SQL = `
  SELECT id, chain_id, tx_hash, log_index, payer_address, amount_raw, block_time,
         match_kind, matched_payment_intent_id, matched_receipt_id,
         balance_consumed, sender_is_own_address
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
