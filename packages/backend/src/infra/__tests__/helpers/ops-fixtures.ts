/**
 * Seed helpers for the ops console's real-DB tests (#3512). Each helper
 * inserts the minimum NOT NULL columns of one table through the main pool
 * and returns the new row's id.
 */
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'

let seq = 0
const next = () => ++seq

export const OPS_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'

export function hexOf(n: number, bytes: number): string {
  return `0x${n.toString(16).padStart(bytes * 2, '0')}`
}

export async function seedOpsUser(email?: string, name: string | null = 'Ada Lovelace'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'never-returned-hash', $2) RETURNING id`,
    [email ?? `ops-user-${next()}-${randomUUID()}@customer.example`, name],
  )
  return rows[0].id
}

export async function seedOpsAccount(
  userId: string,
  opts: { address?: string; chainId?: number; accountType?: 'delegator_hybrid' | 'legacy_safe' } = {},
): Promise<string> {
  const accountType = opts.accountType ?? 'delegator_hybrid'
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      opts.address ?? hexOf(0xa00000 + next(), 20),
      opts.chainId ?? 84532,
      accountType === 'legacy_safe' ? 'allowance_module' : 'delegation',
      accountType,
    ],
  )
  return rows[0].id
}

export async function seedOpsAgent(
  userId: string,
  opts: { accountId?: string | null; status?: string; delegate?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, status, delegate_address, api_key_hash, api_key_prefix)
     VALUES ($1, $2, $3, $4, $5, $6, 'sk_agent_ops') RETURNING id`,
    [
      userId,
      opts.accountId ?? null,
      `Ops agent ${next()}`,
      opts.status ?? 'active',
      opts.delegate ?? hexOf(0xb00000 + next(), 20),
      `never-returned-key-hash-${randomUUID()}`,
    ],
  )
  return rows[0].id
}

export async function seedOpsDelegation(
  agentId: string,
  opts: { status?: string; recipient?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash, delegation_json, version, status,
        budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, 84532, $2, $3, $4, '{"signed":"never-returned"}', 1, $5, '1000000', 86400, 0, 9999999999)
     RETURNING id`,
    [agentId, OPS_USDC, opts.recipient ?? null, hexOf(0xd00000 + next(), 32), opts.status ?? 'active'],
  )
  return rows[0].id
}

export async function seedOpsIntent(
  userId: string,
  agentId: string,
  opts: { txHash?: string | null; status?: string; createdAt?: string; error?: string | null } = {},
): Promise<string> {
  const addr = hexOf(0xc00000 + next(), 20)
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address, amount_raw, amount_human,
        delegate_address, allowance_nonce, sign_hash, expires_at, status, tx_hash, error_message, signature, created_at)
     VALUES ($1, $2, $3, 'USDC', $4, $3, '1000', '0.001', $3, 0, $5, NOW() + interval '1 hour', $6, $7, $8,
             '0xsignature-never-returned', COALESCE($9::timestamptz, NOW()))
     RETURNING id`,
    [
      agentId,
      userId,
      addr,
      OPS_USDC,
      hexOf(0xe00000 + next(), 32),
      opts.status ?? 'confirmed',
      opts.txHash ?? null,
      opts.error ?? null,
      opts.createdAt ?? null,
    ],
  )
  return rows[0].id
}

export async function seedOpsRefusal(
  userId: string,
  agentId: string,
  opts: { reason?: string; createdAt?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_refusals (user_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source, created_at)
     VALUES ($1, $2, 84532, 'USDC', '5000', $3, 'payment', COALESCE($4::timestamptz, NOW())) RETURNING id`,
    [userId, agentId, opts.reason ?? 'delegation_budget_exceeded', opts.createdAt ?? null],
  )
  return rows[0].id
}

export async function seedOpsSystemTx(txHash: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, tx_hash)
     VALUES (84532, 'sweep', $1, '0x', '0', 'mined', $2) RETURNING id`,
    [hexOf(0xf00000 + next(), 20), txHash],
  )
  return rows[0].id
}
