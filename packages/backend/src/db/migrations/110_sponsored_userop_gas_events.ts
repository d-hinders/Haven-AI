import type { PoolClient } from 'pg'

export const version = '110_sponsored_userop_gas_events'

/**
 * Sponsored-UserOp gas ledger for the delegation payment path (#3837).
 *
 * Every UserOp submitted through `submitDelegationPayment` — the ONE caller
 * is `POST /payments/:id/sign` (`routes/payments.ts`), which carries both
 * direct payments and the x402 EIP-3009 funding leg — records the EntryPoint
 * receipt's `actualGasCost` here, tagged direct vs funding leg. A
 * landed-but-reverted op burned sponsored gas and is recorded with its cost
 * (via the widened `SubmittedUserOpFailedError`); a `receipt_unconfirmed` op
 * has no known cost and is recorded with `actual_gas_cost_wei` NULL.
 *
 * Deliberately a SEPARATE table, not new rows in `relayer_gas_events` (054):
 * that table is simultaneously the relayer budget guard's count substrate
 * (`countRecentEvents` filters `operation`) and the user-facing
 * `gas_sponsored_ops` figure (`GAS_EVENTS_BY_CHAIN_SQL` counts every row),
 * and the `RelayerOperation` union keys the budget RULES — new operation
 * kinds there would either trip none of that or change the meaning of both
 * readers. This table is monitoring only: nothing counts it before signing,
 * nothing fails closed on it, and the caller swallows every recording
 * failure (a payment never fails over metrics). erc7710 settlement is not
 * sponsored by Haven (the merchant redeems) and never lands here.
 *
 * Cost basis: the EntryPoint receipt's `actualGasCost`, which INCLUDES
 * `preVerificationGas` — through which bundlers recover Base's L1 data fee —
 * so the transaction-level `l1Fee` is NOT added on top (it would
 * double-count). `payment_intent_id`/`agent_id`/`user_id` are deliberately
 * NOT foreign keys (same reasoning as `relayer_gas_events`): attribution
 * must outlive the actor and must never be able to fail the money path over
 * referential drift.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sponsored_userop_gas_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_intent_id UUID,
      agent_id UUID,
      user_id UUID,
      chain_id INTEGER NOT NULL,
      leg TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('confirmed', 'included_reverted', 'receipt_unconfirmed')),
      user_op_hash TEXT,
      tx_hash TEXT,
      actual_gas_used NUMERIC,
      actual_gas_cost_wei NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // The ops aggregate scans a trailing window and groups by leg + merchant;
  // the day bucket comes from created_at, so this is the covering index.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sponsored_userop_gas_created_at
      ON sponsored_userop_gas_events (created_at)
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS sponsored_userop_gas_events`)
}
