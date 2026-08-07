/**
 * Data access for the platform fee ledger (#999, epic #980).
 *
 * One aggregate: `payment_fees` — the central fee ledger the fee module
 * (`modules/fee/fee-module.ts`, #386) records into. Extracted verbatim from
 * that module so `scripts/db-schema-smoke.ts` can PREPARE both statements.
 * Convention: `README.md` in this directory.
 *
 * Invariant a reader must not break: the insert is idempotent per
 * `payment_id` (`ON CONFLICT DO NOTHING`) — recording twice never
 * double-charges. Do not "improve" it into an upsert; a second record for the
 * same payment is a bug upstream, not new truth.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export const INSERT_PAYMENT_FEE_SQL = `INSERT INTO payment_fees
       (payment_id, rail, fee_amount_atomic, fee_token, fee_sek, tx_ref, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'recorded', NOW())
     ON CONFLICT (payment_id) DO NOTHING`

export const GET_RECORDED_FEE_SQL = `SELECT payment_id, fee_amount_atomic, fee_token, fee_sek, status
     FROM payment_fees WHERE payment_id = $1`

export interface RecordedFeeRow {
  payment_id: string
  fee_amount_atomic: string
  fee_token: string | null
  fee_sek: string | null
  status: string
}

/**
 * Scoped by `paymentId`: fee rows are per-payment, and every caller reaches
 * this through a payment it already owns (the fee module records against the
 * intent/approval the payment path resolved).
 */
export async function insertPaymentFee(
  input: {
    paymentId: string
    rail: string
    feeAmountAtomic: string
    feeToken: string
    feeSek: string | null
    txRef: string | null
  },
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_PAYMENT_FEE_SQL, [
    input.paymentId,
    input.rail,
    input.feeAmountAtomic,
    input.feeToken,
    input.feeSek,
    input.txRef,
  ])
}

export async function getRecordedFeeRow(
  paymentId: string,
  db: Executor = pool,
): Promise<RecordedFeeRow | null> {
  const result = await db.query<RecordedFeeRow>(GET_RECORDED_FEE_SQL, [paymentId])
  return result.rows[0] ?? null
}
