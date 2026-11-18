/**
 * The Stripe deposit-address registry's storage (#4952, epic #4886).
 *
 * A registration is the Sales account's OWNER's word that a processor receives
 * on their behalf at this address; Haven cannot verify it. Every statement is
 * scoped to the account (the read the ingest makes) or to the account AND user
 * (the owner's routes). Rows are never deleted: retiring sets `retired_at`.
 * One active registration per `(chain_id, address)` is the partial unique
 * index of migration 134, so a register is `ON CONFLICT DO NOTHING` and a
 * conflict is "someone already holds it".
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export interface MerchantDepositAddressRow {
  id: string
  account_id: string
  user_id: string
  chain_id: number
  address: string
  registered_at: Date
  retired_at: Date | null
}

const COLUMNS = 'id, account_id, user_id, chain_id, address, registered_at, retired_at'

/** The account's registrations, active and retired, newest first. */
export async function listDepositAddresses(
  scope: { accountId: string; userId: string },
  db: Executor = pool,
): Promise<MerchantDepositAddressRow[]> {
  const result = await db.query<MerchantDepositAddressRow>(
    `SELECT ${COLUMNS}
       FROM merchant_deposit_addresses
      WHERE account_id = $1 AND user_id = $2
      ORDER BY registered_at DESC, id`,
    [scope.accountId, scope.userId],
  )
  return result.rows
}

/**
 * Register `address` (lower-case) for the account. Returns the new row, or
 * null when the address already has an active registration on this chain (on
 * any account).
 */
export async function insertDepositAddress(
  input: { accountId: string; userId: string; chainId: number; address: string },
  db: Executor = pool,
): Promise<MerchantDepositAddressRow | null> {
  const result = await db.query<MerchantDepositAddressRow>(
    `INSERT INTO merchant_deposit_addresses (account_id, user_id, chain_id, address)
     VALUES ($1, $2, $3, LOWER($4))
     ON CONFLICT (chain_id, address) WHERE retired_at IS NULL DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.accountId, input.userId, input.chainId, input.address],
  )
  return result.rows[0] ?? null
}

/** One registration of this account and user, or null. */
export async function findDepositAddress(
  scope: { accountId: string; userId: string },
  id: string,
  db: Executor = pool,
): Promise<MerchantDepositAddressRow | null> {
  const result = await db.query<MerchantDepositAddressRow>(
    `SELECT ${COLUMNS}
       FROM merchant_deposit_addresses
      WHERE id = $1 AND account_id = $2 AND user_id = $3`,
    [id, scope.accountId, scope.userId],
  )
  return result.rows[0] ?? null
}

/**
 * Retire a registration: sets `retired_at`, nothing is deleted. Returns the
 * row, or null when it is not an active registration of this account and user.
 */
export async function retireDepositAddress(
  scope: { accountId: string; userId: string },
  id: string,
  db: Executor = pool,
): Promise<MerchantDepositAddressRow | null> {
  const result = await db.query<MerchantDepositAddressRow>(
    `UPDATE merchant_deposit_addresses
        SET retired_at = NOW()
      WHERE id = $1 AND account_id = $2 AND user_id = $3 AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [id, scope.accountId, scope.userId],
  )
  return result.rows[0] ?? null
}

/**
 * Every registration of this account on this chain, active or retired: the
 * ingest filters each leg by the window (`registered_at <= block time` and not
 * retired by it). Scoped to the key's account, so it says nothing about any
 * other account's addresses.
 */
export async function listAccountDepositWindows(
  accountId: string,
  chainId: number,
  db: Executor = pool,
): Promise<Array<{ address: string; registered_at: Date; retired_at: Date | null }>> {
  const result = await db.query<{ address: string; registered_at: Date; retired_at: Date | null }>(
    `SELECT address, registered_at, retired_at
       FROM merchant_deposit_addresses
      WHERE account_id = $1 AND chain_id = $2`,
    [accountId, chainId],
  )
  return result.rows
}
