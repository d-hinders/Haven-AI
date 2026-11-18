/**
 * The sales ingest (#4897, epic #4885): a sale record is accepted only against
 * a transfer Haven read from the chain.
 *
 * ## What is trusted
 *
 * The account is the merchant key's account (`request.merchant`), never the
 * record's. Amount, payer, token and time come ONLY from the chain read's legs:
 * the record's `amount` and `payer` are validated by the schema and used by
 * nothing here, and no existing `inbound_transfers` row is consulted either —
 * rows written by the old caller-supplied route and the explorer carry
 * `log_index NULL`, so a row's presence is not proof the chain carried the
 * transfer (#4940 review S3). The legs are indexed through the idempotent
 * `ingestInboundTransfers` first, then the sale row is written; the sale is not
 * a match kind and never touches `match_kind`, `balance_consumed` or the
 * receive balance.
 *
 * ## Stripe-held sales (#4952, dev and Stripe sandbox only)
 *
 * When a confirmed transaction pays the key's Sales account nothing, the legs
 * to the account's REGISTERED deposit addresses are read instead (the registry
 * is the owner's own word, never the record's). A leg counts only when its
 * address is registered to this account and was active at the leg's block time.
 * The sale is stored with `held_by = 'stripe'` and `receiving_address` from the
 * registry, and NO `inbound_transfers` row is written, so it is in no balance.
 * When legs go to several registered addresses, only those to the first one by
 * log index count, so the row's address and amount agree.
 * A transaction that pays the account AND a registered address is an account
 * sale counting only the legs into the account. Legs to another account's
 * address, an unregistered one, or one outside its window all get the same 422
 * `no_payment_to_account` as a hash that paid nobody. The sale record itself is
 * unchanged.
 *
 * ## The answers
 *
 * - new sale 201; identical resend 200 (nothing written); a different record for
 *   the same transaction 409 `sale_record_conflict`, the first stands;
 * - receipt not found, or fewer than `SALE_CONFIRMATIONS` confirmations: 425
 *   `transaction_not_visible` — the retry answer, distinct from every refusal;
 * - confirmed with no USDC leg into the account: 422 `no_payment_to_account`,
 *   the same answer whether the transaction paid another Haven account or
 *   nobody (no oracle: the read is scoped to the key's own account and nothing
 *   else is looked up);
 * - the chain cannot be read: 503 `chain_unavailable`, nothing stored.
 *
 * Authority note (money-path gate): nothing here holds a key, signs, moves
 * funds or settles for anyone. It records a merchant's statement beside a
 * chain read.
 */
import {
  findMerchantSale,
  insertMerchantSale,
  type MerchantSaleRow,
  type MerchantSaleVatTreatment,
} from '../../infra/repositories/merchant-sales.js'
import { listOwnAccountAddresses } from '../../infra/repositories/inbound-transfers.js'
import {
  depositAddressActiveAt,
  listAccountDepositAddresses,
} from '../../infra/repositories/merchant-deposit-addresses.js'
import {
  readInboundTransactionByTxHash,
  type ChainInboundLeg,
} from './chain-read.js'
import { ingestInboundTransfers, TX_HASH_PATTERN, type InboundIngestLogger } from './receive.js'

/** Confirmations a transaction needs before a sale is accepted against it. */
export const SALE_CONFIRMATIONS = 3

/** Seconds a reporter waits after the 425 answer. */
export const SALE_RETRY_AFTER_SECONDS = 10

/** The one record version Haven reads. */
export const SALE_RECORD_VERSION = 1

export interface SaleRecordInput {
  version?: number
  tx_hash: string
  chain: string
  product_id: string
  product_name?: string
  /** Validated by the schema; deliberately unused. */
  amount: string
  /** Validated by the schema; deliberately unused. */
  payer: string
  merchant_reference: string
  receipt_number?: string
  vat_treatment?: MerchantSaleVatTreatment
}

export interface SaleMerchant {
  user_id: string
  account_id: string
  account_address: string
  chain_id: number
}

export type SaleFailureCode =
  | 'unsupported_record_version'
  | 'invalid_record'
  | 'chain_mismatch'
  | 'sale_record_conflict'
  | 'transaction_not_visible'
  | 'no_payment_to_account'
  | 'chain_unavailable'

export type IngestSaleResult =
  | { ok: true; created: boolean; sale: MerchantSaleRow }
  | {
      ok: false
      failure: {
        status: 400 | 409 | 422 | 425 | 503
        code: SaleFailureCode
        message: string
        retryAfterSeconds?: number
      }
    }

function fail(
  status: 400 | 409 | 422 | 425 | 503,
  code: SaleFailureCode,
  message: string,
  retryAfterSeconds?: number,
): IngestSaleResult {
  return { ok: false, failure: { status, code, message, retryAfterSeconds } }
}

/** What the record says about the sale, with absent optionals as null. */
function recordFields(record: SaleRecordInput) {
  return {
    productId: record.product_id,
    productName: record.product_name ?? null,
    merchantReference: record.merchant_reference,
    receiptNumber: record.receipt_number ?? null,
    vatTreatment: record.vat_treatment ?? null,
  }
}

/** An identical resend: every field the record carries equals the stored one. */
function isSameRecord(row: MerchantSaleRow, record: SaleRecordInput): boolean {
  const f = recordFields(record)
  return (
    row.product_id === f.productId &&
    row.product_name === f.productName &&
    row.merchant_reference === f.merchantReference &&
    row.receipt_number === f.receiptNumber &&
    row.vat_treatment === f.vatTreatment
  )
}

function answerFor(row: MerchantSaleRow, record: SaleRecordInput): IngestSaleResult {
  if (isSameRecord(row, record)) return { ok: true, created: false, sale: row }
  return fail(
    409,
    'sale_record_conflict',
    'This transaction already has a different sale record on the account. The first record stands.',
  )
}

/** The chain facts of a sale, derived from the legs alone. */
export function saleFactsFromLegs(
  legs: ChainInboundLeg[],
  ownAddresses: ReadonlySet<string>,
): {
  amountRaw: string
  payerAddress: string | null
  severalPayers: boolean
  senderIsOwnAddress: boolean
} {
  let revenue = 0n
  const revenuePayers = new Set<string>()
  const allPayers = new Set<string>()
  for (const leg of legs) {
    const payer = leg.payerAddress.toLowerCase()
    allPayers.add(payer)
    if (ownAddresses.has(payer)) continue
    revenuePayers.add(payer)
    revenue += BigInt(leg.amountRaw)
  }
  // The payer is attributed over the legs that count as revenue, so one own leg
  // beside one customer leg is the customer's sale, not "several payers". With
  // no revenue leg (an own-only transaction) it is read over all legs.
  const payers = revenuePayers.size > 0 ? revenuePayers : allPayers
  const single = payers.size === 1 ? [...payers][0] : null
  return {
    amountRaw: revenue.toString(),
    payerAddress: single,
    severalPayers: payers.size > 1,
    senderIsOwnAddress: revenuePayers.size === 0,
  }
}

export async function ingestMerchantSale(input: {
  merchant: SaleMerchant
  record: SaleRecordInput
  log: InboundIngestLogger
}): Promise<IngestSaleResult> {
  const { merchant, record } = input

  if (record.version !== undefined && record.version !== SALE_RECORD_VERSION) {
    return fail(
      400,
      'unsupported_record_version',
      `Sale record version ${String(record.version)} is not supported: version 1 is the only version.`,
    )
  }
  if (typeof record.tx_hash !== 'string' || !TX_HASH_PATTERN.test(record.tx_hash)) {
    return fail(400, 'invalid_record', 'tx_hash must be a 0x-prefixed 32-byte hash.')
  }
  if (record.chain !== `eip155:${merchant.chain_id}`) {
    return fail(
      422,
      'chain_mismatch',
      `This key's account is on eip155:${merchant.chain_id}; the record names ${String(record.chain)}.`,
    )
  }

  const txHash = record.tx_hash.toLowerCase()

  // An existing record of THIS account answers without a chain read: it is the
  // account's own data, so it tells the caller nothing about any other account.
  const existing = await findMerchantSale(merchant.account_id, merchant.chain_id, txHash)
  if (existing) return answerFor(existing, record)

  // #4952: the account's registered Stripe deposit addresses, every window
  // (active or retired). Only THIS account's rows: nothing here can reveal
  // another account's registrations.
  const registered = await listAccountDepositAddresses(merchant.account_id, merchant.chain_id)
  const read = await readInboundTransactionByTxHash(
    merchant.chain_id,
    merchant.account_address,
    txHash,
    registered,
  )
  if (!read.ok) {
    return fail(503, 'chain_unavailable', 'The chain could not be read; nothing was stored. Try again.')
  }
  const notVisible = fail(
    425,
    'transaction_not_visible',
    `The transaction is not visible with ${SALE_CONFIRMATIONS} confirmations yet. Send the same record again in ${SALE_RETRY_AFTER_SECONDS} seconds.`,
    SALE_RETRY_AFTER_SECONDS,
  )
  if (!read.receiptFound) return notVisible
  if (read.latestBlock - read.blockNumber + 1 < SALE_CONFIRMATIONS) return notVisible

  const noPayment = () =>
    fail(422, 'no_payment_to_account', 'That transaction has no USDC transfer into this key\'s account.')

  // A transaction that pays the Sales account is an account sale, counting only
  // the legs into the account, whatever else it also paid (#4952).
  let saleLegs: ChainInboundLeg[] = read.legs
  let heldBy: 'account' | 'stripe' = 'account'
  let receivingAddress: string | null = null
  if (read.legs.length === 0) {
    // It paid the account nothing: the legs to a registered address count only
    // while that registration was active at the leg's block time. Every other
    // case (another account's address, an unregistered one, registered after
    // the block or retired before it) is the same answer as a hash that paid
    // nobody.
    const counted = []
    for (const o of read.otherLegs ?? []) {
      if (
        await depositAddressActiveAt(merchant.account_id, merchant.chain_id, o.toAddress, o.leg.blockTime)
      ) {
        counted.push(o)
      }
    }
    counted.sort((x, y) => x.leg.logIndex - y.leg.logIndex)
    if (counted.length === 0) return noPayment()
    // One sale, one address: only the legs to the FIRST registered address (by
    // log index) count, so the row's address and its amount agree.
    const first = counted[0].toAddress
    saleLegs = counted.filter((o) => o.toAddress === first).map((o) => o.leg)
    heldBy = 'stripe'
    receivingAddress = first
  }

  const account = {
    id: merchant.account_id,
    userId: merchant.user_id,
    accountAddress: merchant.account_address,
    chainId: merchant.chain_id,
  }
  // A Stripe-held sale writes NO inbound_transfers row: it would count as
  // received into Haven.
  if (heldBy === 'account') await ingestInboundTransfers(account, read.legs, input.log)

  const own = new Set(await listOwnAccountAddresses(merchant.user_id))
  const facts = saleFactsFromLegs(saleLegs, own)
  const fields = recordFields(record)

  const inserted = await insertMerchantSale({
    accountId: merchant.account_id,
    userId: merchant.user_id,
    chainId: merchant.chain_id,
    txHash,
    recordVersion: SALE_RECORD_VERSION,
    ...fields,
    amountRaw: facts.amountRaw,
    tokenAddress: saleLegs[0].tokenAddress.toLowerCase(),
    payerAddress: facts.payerAddress,
    severalPayers: facts.severalPayers,
    senderIsOwnAddress: facts.senderIsOwnAddress,
    blockNumber: read.blockNumber,
    blockTime: saleLegs[0].blockTime,
    heldBy,
    receivingAddress,
  })
  if (inserted) return { ok: true, created: true, sale: inserted }

  // Lost a race on the unique index: the winner's row is the answer.
  const winner = await findMerchantSale(merchant.account_id, merchant.chain_id, txHash)
  if (!winner) {
    // The row that beat this insert is gone again (cleared between the two
    // statements): the record changed while it was being written.
    return fail(
      409,
      'sale_record_conflict',
      'The sale record for this transaction changed while it was being written. Read it again and resend if it is still wanted.',
    )
  }
  return answerFor(winner, record)
}

/** The wire shape of a sale. */
export function serializeSale(row: MerchantSaleRow): Record<string, unknown> {
  return {
    id: row.id,
    tx_hash: row.tx_hash,
    chain: `eip155:${row.chain_id}`,
    record_version: row.record_version,
    product_id: row.product_id,
    product_name: row.product_name,
    merchant_reference: row.merchant_reference,
    receipt_number: row.receipt_number,
    vat_treatment: row.vat_treatment,
    amount_raw: row.amount_raw,
    token_address: row.token_address,
    payer_address: row.payer_address,
    several_payers: row.several_payers,
    sender_is_own_address: row.sender_is_own_address,
    held_by: row.held_by,
    receiving_address: row.receiving_address,
    block_number: Number(row.block_number),
    block_time: new Date(row.block_time).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  }
}
