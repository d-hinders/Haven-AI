/**
 * #3423 slice B (item 2), on the real-DB harness: a second POST
 * /x402/:id/settle of an erc7710 payment that already settled answers a typed
 * 409 carrying the settlement hash, and writes nothing. It returns before any
 * signing, merchant or chain step, so the real `settleX402` runs here unmocked.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { findSettleIntent } from '../../../infra/repositories/x402-authorizations.js'
import { settleX402 } from '../settle.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'

const TX = `0x${'7d'.repeat(32)}`
let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`resettle-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'resettle agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(opts: {
  agentId: string
  userId: string
  status: string
  txHash: string | null
  scheme: 'erc7710' | 'eip3009' | null
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, execution_rail, tx_hash, machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000aa',
             '1000', '0.001', '0x00000000000000000000000000000000000000d1', 0, $3,
             $4, NOW() + interval '10 minutes', 'x402', 'delegation', $5, $6::jsonb)
     RETURNING id`,
    [
      opts.agentId,
      opts.userId,
      `0x${String(++seq).padStart(64, 'b')}`.slice(0, 66),
      opts.status,
      opts.txHash,
      opts.scheme ? JSON.stringify({ settlement_scheme: opts.scheme }) : null,
    ],
  )
  return r.rows[0].id
}

async function rowSnapshot(id: string) {
  // The whole row: "writes nothing" means no column moved.
  const r = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return r.rows[0]
}

const agentCtx = (agentId: string) => ({ id: agentId }) as unknown as AgentContext

describeDb('POST /x402/:id/settle on an already-settled payment (#3423)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('findSettleIntent carries tx_hash', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId, status: 'confirmed', txHash: TX, scheme: 'erc7710' })
    expect((await findSettleIntent(id, agentId))!.tx_hash).toBe(TX)
  })

  it('a confirmed erc7710 intent answers 409 payment_already_settled with its tx_hash, and writes nothing', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId, status: 'confirmed', txHash: TX, scheme: 'erc7710' })
    const before = await rowSnapshot(id)

    const res = await settleX402(agentCtx(agentId), id, `0x${'11'.repeat(65)}`)

    expect(res.code).toBe(409)
    expect(res.body).toMatchObject({ code: 'payment_already_settled', payment_id: id, tx_hash: TX })
    expect(await rowSnapshot(id)).toEqual(before)
  })

  it('a confirmed EIP-3009 funding row keeps the plain 409: its tx_hash proves only funding', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId, status: 'confirmed', txHash: TX, scheme: 'eip3009' })
    const res = await settleX402(agentCtx(agentId), id, `0x${'11'.repeat(65)}`)
    expect(res.code).toBe(409)
    expect(res.body).not.toHaveProperty('code')
    expect((res.body as { error: string }).error).toMatch(/expected pending_signature/)
  })

  it('a submitted erc7710 intent keeps the plain 409 (not settled yet)', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId, status: 'submitted', txHash: null, scheme: 'erc7710' })
    const res = await settleX402(agentCtx(agentId), id, `0x${'11'.repeat(65)}`)
    expect(res.code).toBe(409)
    expect(res.body).not.toHaveProperty('code')
    expect((res.body as { error: string }).error).toMatch(/Payment is submitted, expected pending_signature/)
  })
})
