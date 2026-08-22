/**
 * Real-DB characterization of what agent credential changes do TODAY, before
 * #1698's re-key exists (money-path rule: pin current behaviour first).
 *
 * Every assertion here is about what Postgres actually holds after an
 * existing operation, so it belongs on the real harness rather than on
 * mocks (epic #1219, `docs/contributing/testing-strategy.md`).
 *
 * The shape these tests describe is the gap #1698 closes: today Haven can
 * rotate an API key, and separately revoke a delegation, and neither one
 * touches the other or the delegate address. There is no single operation
 * that retires a whole credential set — which is why every #1569/#1681/#1688
 * instance is a user performing "replace" with the only verb available.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { rotateAgentApiKey } from '../agents.js'
import { revokeDelegationsByHashes } from '../delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'

let seq = 0

interface Seeded {
  userId: string
  agentId: string
  safeId: string
  apiKeyHash: string
}

async function seedAgent(): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rekey${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`],
  )
  const safeId = safe.rows[0].id
  const apiKeyHash = `hash-old-${n}`
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, safe_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, 'Rekey agent', $3, $4, 'sk_agent_old', 'active') RETURNING id`,
    [userId, safeId, OLD_DELEGATE, apiKeyHash],
  )
  return { userId, agentId: agent.rows[0].id, safeId, apiKeyHash }
}

async function seedDelegation(agentId: string, status = 'active'): Promise<string> {
  const hash = `0x${String(++seq).padStart(64, '0')}`
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds, start_date, expires_at)
     VALUES ($1, 84532, $2, NULL, $3, '{"signed":"capability"}', 1, $4, '1000000', 86400, 0, 9999999999)`,
    [agentId, USDC, hash, status],
  )
  return hash
}

async function seedPendingIntent(
  seeded: Seeded,
  delegateAddress: string,
  status = 'pending_signature',
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at)
     VALUES ($1, $2, '0xsafe', 'USDC', $3, '0xmerchant', '1000', '0.001', $4, 0,
             $5, $6, NOW() + interval '10 minutes')
     RETURNING id`,
    [
      seeded.agentId,
      seeded.userId,
      USDC,
      delegateAddress,
      `0x${String(++seq).padStart(64, 'f')}`,
      status,
    ],
  )
  return result.rows[0].id
}

describeDb('#1698 characterization — credential changes today', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('rotate-key changes ONLY the API key — the delegate address is untouched', async () => {
    const seeded = await seedAgent()

    const rotated = await rotateAgentApiKey('hash-new', 'sk_agent_new', seeded.agentId, seeded.userId)
    expect(rotated).toBe(true)

    const row = await db.query<{ api_key_hash: string; api_key_prefix: string; delegate_address: string }>(
      `SELECT api_key_hash, api_key_prefix, delegate_address FROM agents WHERE id = $1`,
      [seeded.agentId],
    )
    expect(row.rows[0].api_key_hash).toBe('hash-new')
    expect(row.rows[0].api_key_prefix).toBe('sk_agent_new')
    // The half that makes this a characterization rather than a feature test:
    // the delegate key is EXACTLY as it was. Rotating the API key today does
    // not rotate the signing key, so the two halves of a credential set can
    // and do drift apart.
    expect(row.rows[0].delegate_address).toBe(OLD_DELEGATE)
  })

  it('revoking every delegation leaves the delegate address and API key live', async () => {
    const seeded = await seedAgent()
    const hash = await seedDelegation(seeded.agentId)

    const flipped = await revokeDelegationsByHashes(seeded.agentId, [hash])
    expect(flipped).toEqual([hash])

    const row = await db.query<{ delegate_address: string; api_key_hash: string; status: string }>(
      `SELECT delegate_address, api_key_hash, status FROM agents WHERE id = $1`,
      [seeded.agentId],
    )
    // An agent with no authority still authenticates with the same API key
    // and still advertises the same delegate. #1681's finding A in the
    // database.
    expect(row.rows[0].delegate_address).toBe(OLD_DELEGATE)
    expect(row.rows[0].api_key_hash).toBe(seeded.apiKeyHash)
    expect(row.rows[0].status).toBe('active')
  })

  it('an unexecuted intent stamped with the old payer SURVIVES a delegation revoke today', async () => {
    const seeded = await seedAgent()
    const hash = await seedDelegation(seeded.agentId)
    const intentId = await seedPendingIntent(seeded, OLD_DELEGATE)

    await revokeDelegationsByHashes(seeded.agentId, [hash])

    const row = await db.query<{ status: string; delegate_address: string }>(
      `SELECT status, delegate_address FROM payment_intents WHERE id = $1`,
      [intentId],
    )
    // This is the window #1698 step 5 closes. Nothing today invalidates an
    // intent quoted against a payer that is being retired; #1690's
    // signer-side guard is the only thing standing between it and a
    // mis-payer signature, and the epic says that guard is a backstop, not
    // the primary defence.
    expect(row.rows[0].status).toBe('pending_signature')
    expect(row.rows[0].delegate_address).toBe(OLD_DELEGATE)
  })

  it('payment_intents carries the payer stamp as a first-class column', async () => {
    // #1698's intent invalidation needs to distinguish "quoted against the
    // old payer" precisely rather than expiring an agent's whole queue.
    // `delegate_address` is that stamp and it is NOT nullable, so every
    // intent — legacy rail and delegation rail alike — carries one.
    const seeded = await seedAgent()
    const oldPayer = await seedPendingIntent(seeded, OLD_DELEGATE)
    const otherPayer = await seedPendingIntent(seeded, '0x00000000000000000000000000000000000000e2')
    const executed = await seedPendingIntent(seeded, OLD_DELEGATE, 'confirmed')

    const rows = await db.query<{ id: string; delegate_address: string; status: string }>(
      `SELECT id, delegate_address, status FROM payment_intents WHERE agent_id = $1 ORDER BY created_at`,
      [seeded.agentId],
    )
    expect(rows.rows).toHaveLength(3)
    expect(rows.rows.find((r) => r.id === oldPayer)?.delegate_address).toBe(OLD_DELEGATE)
    expect(rows.rows.find((r) => r.id === otherPayer)?.delegate_address).not.toBe(OLD_DELEGATE)
    expect(rows.rows.find((r) => r.id === executed)?.status).toBe('confirmed')

    const notNull = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'payment_intents' AND column_name = 'delegate_address'
          AND table_schema = current_schema()`,
    )
    expect(notNull.rows[0].is_nullable).toBe('NO')
  })
})
