/**
 * The merchant sale record's storage (#4897, epic #4885).
 *
 * Every statement is scoped to the account (the account comes from the merchant
 * key, never the request). The table is its own: nothing here reads or writes
 * `inbound_transfers.match_kind`, `balance_consumed` or the receive balance.
 *
 * The unique index `(chain_id, LOWER(tx_hash), account_id)` is the one-record
 * rule, so the insert is `ON CONFLICT DO NOTHING` and a lost race is answered
 * by reading the winner's row.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type MerchantSaleVatTreatment = 'SE_25' | 'REVERSE_CHARGE'

export interface MerchantSaleRow {
  id: string
  account_id: string
  user_id: string
  chain_id: number
  tx_hash: string
  held_by: 'account' | 'stripe'
  receiving_address: string | null
  record_version: number
  product_id: string
  product_name: string | null
  merchant_reference: string
  receipt_number: string | null
  vat_treatment: MerchantSaleVatTreatment | null
  amount_raw: string
  token_address: string
  payer_address: string | null
  several_payers: boolean
  sender_is_own_address: boolean
  block_number: string
  block_time: Date
  created_at: Date
}

const COLUMNS = `id, account_id, user_id, chain_id, tx_hash, held_by, receiving_address,
  record_version, product_id, product_name, merchant_reference, receipt_number,
  vat_treatment, amount_raw::text AS amount_raw, token_address, payer_address,
  several_payers, sender_is_own_address, block_number::text AS block_number,
  block_time, created_at`

/** The sale already stored for this transaction on this account, or null. */
export async function findMerchantSale(
  accountId: string,
  chainId: number,
  txHash: string,
  db: Executor = pool,
): Promise<MerchantSaleRow | null> {
  const result = await db.query<MerchantSaleRow>(
    `SELECT ${COLUMNS}
       FROM merchant_sales
      WHERE account_id = $1
        AND chain_id = $2
        AND LOWER(tx_hash) = LOWER($3)`,
    [accountId, chainId, txHash],
  )
  return result.rows[0] ?? null
}

export interface InsertMerchantSaleInput {
  accountId: string
  userId: string
  chainId: number
  txHash: string
  recordVersion: number
  productId: string
  productName: string | null
  merchantReference: string
  receiptNumber: string | null
  vatTreatment: MerchantSaleVatTreatment | null
  /** Chain facts, copied from the legs the chain read returned. */
  amountRaw: string
  tokenAddress: string
  payerAddress: string | null
  severalPayers: boolean
  senderIsOwnAddress: boolean
  blockNumber: number
  blockTime: Date
}

/**
 * Store the sale. Returns the new row, or null when the transaction already
 * has a record on this account (the caller then reads the winner).
 * `held_by` and `receiving_address` keep their defaults ('account', NULL):
 * #4952 owns any other value.
 */
export async function insertMerchantSale(
  input: InsertMerchantSaleInput,
  db: Executor = pool,
): Promise<MerchantSaleRow | null> {
  const result = await db.query<MerchantSaleRow>(
    `INSERT INTO merchant_sales (
       account_id, user_id, chain_id, tx_hash, record_version, product_id,
       product_name, merchant_reference, receipt_number, vat_treatment,
       amount_raw, token_address, payer_address, several_payers,
       sender_is_own_address, block_number, block_time
     )
     VALUES ($1, $2, $3, LOWER($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (chain_id, LOWER(tx_hash), account_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.accountId,
      input.userId,
      input.chainId,
      input.txHash,
      input.recordVersion,
      input.productId,
      input.productName,
      input.merchantReference,
      input.receiptNumber,
      input.vatTreatment,
      input.amountRaw,
      input.tokenAddress,
      input.payerAddress,
      input.severalPayers,
      input.senderIsOwnAddress,
      input.blockNumber,
      input.blockTime,
    ],
  )
  return result.rows[0] ?? null
}
