/**
 * Real-DB test for #3307 (owner decision: payment status is in scope): the
 * payment-status response checksums its Haven-owned addresses at its own read
 * boundary, the same rule as the receipt (`mapEvidence`) and the transactions
 * feed (#3129), so the three agent-facing surfaces agree byte for byte.
 *
 * LETTER-BEARING, deliberately mis-cased inputs: a digit-only address is
 * unchanged by checksumming and would pass on the old code.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { ethers } from 'ethers'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getAgentPaymentStatus } from '../agent-payment-status.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

const MIXED = (pair: string) => `0x${pair.repeat(20)}`
const ACCOUNT = MIXED('cD')
const DELEGATE = MIXED('bC')
const DELEGATE_ACCOUNT = MIXED('dE')
const MERCHANT = MIXED('aB')
const TOKEN = MIXED('Fa')
const checksum = (a: string) => ethers.getAddress(a.toLowerCase())
let seq = 0

async function seedX402(): Promise<{ agent: AgentContext; paymentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`status-case-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agentRow = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'status casing agent') RETURNING id`,
    [userId],
  )
  const agentId = agentRow.rows[0].id
  // Stored as the writers store them: lowercase.
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, x402_merchant_address, x402_resource_url, machine_metadata)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '100000', '0.10', $6, 0, '0xsign',
             'pending_signature', NOW() + interval '10 minutes', 'x402', 'x402', $7,
             'https://merchant.example/r', $8::jsonb)
     RETURNING id`,
    [
      agentId,
      userId,
      ACCOUNT.toLowerCase(),
      TOKEN.toLowerCase(),
      DELEGATE.toLowerCase(),
      DELEGATE.toLowerCase(),
      MERCHANT.toLowerCase(),
      JSON.stringify({ delegate_account_address: DELEGATE_ACCOUNT.toLowerCase() }),
    ],
  )
  return {
    agent: {
      id: agentId,
      user_id: userId,
      name: 'status casing agent',
      delegate_address: DELEGATE.toLowerCase(),
      account_address: ACCOUNT.toLowerCase(),
      chain_id: 84532,
      status: 'active',
    },
    paymentId: intent.rows[0].id,
  }
}

describeDb('payment status addresses are checksummed at the read boundary (#3307)', () => {
  it('resume state keeps the merchant-facing payment requirement exactly as stored', async () => {
    const { getAgentPaymentResumeState } = await import('../agent-payment-status.js')
    const { agent, paymentId } = await seedX402()
    const lookup = await getAgentPaymentResumeState(agent, paymentId)
    const resume = lookup.resumeState as Record<string, any>
    expect(resume.accepted.payTo).toBe(MERCHANT.toLowerCase())
    expect(resume.accepted.asset).toBe(TOKEN.toLowerCase())
    expect(resume.paymentRequired.accepts[0].payTo).toBe(MERCHANT.toLowerCase())
  })

  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('top-level and parties addresses are EIP-55 checksummed; the rail context stays as stored', async () => {
    const { agent, paymentId } = await seedX402()
    const status = (await getAgentPaymentStatus(agent, paymentId)) as Record<string, any>
    expect(status).not.toBeNull()
    expect(status.merchant_address).toBe(checksum(MERCHANT))
    expect(status.payer_address).toBe(checksum(DELEGATE))
    // The x402 context is the stored protocol record: resume-state rebuilds the
    // merchant-facing `accepted.payTo` / `asset` from it, so it is NOT re-cased.
    expect(status.asset).toBe(TOKEN.toLowerCase())
    expect(status.x402.asset).toBe(TOKEN.toLowerCase())
    expect(status.x402.merchant_address).toBe(MERCHANT.toLowerCase())
    expect(status.parties).toEqual({
      treasury_account: checksum(ACCOUNT),
      delegate: checksum(DELEGATE),
      delegate_account: checksum(DELEGATE_ACCOUNT),
      merchant: checksum(MERCHANT),
    })
  })
})
