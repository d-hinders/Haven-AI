/**
 * Real-DB tests for #3307 (owner decision: payment status is in scope).
 *
 * 1. Payment status checksums EVERY Haven-owned address it returns — top
 *    level, the rail context (`asset`, `x402.*`) and `parties` — the same rule
 *    as the receipt (`mapEvidence`) and the transactions feed (#3129).
 * 2. The resume lookup embeds that checksummed status, but REBUILDS its
 *    merchant-bound payment objects (`accepted`, `paymentRequired`) from the
 *    row in STORED casing, so those bytes do not change.
 * 3. Cross-surface: for one payment, the receipt row and the status response
 *    carry byte-equal AND checksummed addresses.
 *
 * Every seed is written lowercase and asserted to differ from its checksum
 * form: an address that checksums to itself (e.g. `0x…00f1`) would pass on the
 * old code and prove nothing.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { ethers } from 'ethers'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { upsertEvidenceBase } from '../../../infra/repositories/machine-payments.js'
import { listReceipts } from '../../mpp/evidence.js'
import { getAgentPaymentResumeState, getAgentPaymentStatus } from '../agent-payment-status.js'
import { type AgentContext } from '../../../middleware/agentAuth.js'

const MIXED = (pair: string) => `0x${pair.repeat(20)}`
const ACCOUNT = MIXED('cD')
const DELEGATE = MIXED('bC')
const DELEGATE_ACCOUNT = MIXED('dE')
const MERCHANT = MIXED('aB')
const TOKEN = MIXED('Fa')
const SEEDS = { ACCOUNT, DELEGATE, DELEGATE_ACCOUNT, MERCHANT, TOKEN }
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
  // Every address stored LOWERCASE.
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
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('every seed differs from its checksum form — otherwise these tests would pass on the old code', () => {
    for (const [name, address] of Object.entries(SEEDS)) {
      expect(checksum(address), name).not.toBe(address.toLowerCase())
    }
  })

  it('status checksums EVERY address: top level, rail context (asset, x402.*) and parties', async () => {
    const { agent, paymentId } = await seedX402()
    const status = (await getAgentPaymentStatus(agent, paymentId)) as Record<string, any>
    expect(status.merchant_address).toBe(checksum(MERCHANT))
    expect(status.payer_address).toBe(checksum(DELEGATE))
    expect(status.asset).toBe(checksum(TOKEN))
    expect(status.x402.asset).toBe(checksum(TOKEN))
    expect(status.x402.merchant_address).toBe(checksum(MERCHANT))
    expect(status.parties).toEqual({
      treasury_account: checksum(ACCOUNT),
      delegate: checksum(DELEGATE),
      delegate_account: checksum(DELEGATE_ACCOUNT),
      merchant: checksum(MERCHANT),
    })
  })

  it('resume EMBEDS the checksummed status but rebuilds its merchant-bound payment objects in STORED casing', async () => {
    const { agent, paymentId } = await seedX402()
    const lookup = await getAgentPaymentResumeState(agent, paymentId)
    const embedded = lookup.status as Record<string, any>
    expect(embedded.merchant_address).toBe(checksum(MERCHANT))
    expect(embedded.x402.merchant_address).toBe(checksum(MERCHANT))

    const resume = lookup.resumeState as Record<string, any>
    expect(resume.accepted.payTo).toBe(MERCHANT.toLowerCase())
    expect(resume.accepted.asset).toBe(TOKEN.toLowerCase())
    expect(resume.paymentRequired.accepts[0].payTo).toBe(MERCHANT.toLowerCase())
    expect(resume.merchantAddress).toBe(MERCHANT.toLowerCase())
  })

  it('CROSS-SURFACE: the receipt row and the status response carry byte-equal, checksummed addresses for one payment', async () => {
    const { agent, paymentId } = await seedX402()
    await upsertEvidenceBase({
      paymentIntentId: paymentId,
      approvalRequestId: null,
      agentId: agent.id,
      userId: agent.user_id,
      rail: 'x402',
      txHash: `0x${'ab'.repeat(32)}`,
      chainId: 84532,
      resourceUrl: 'https://merchant.example/r',
      merchantAddress: MERCHANT.toLowerCase(),
      payerAddress: ACCOUNT.toLowerCase(),
      settlementAddress: DELEGATE.toLowerCase(),
      tokenSymbol: 'USDC',
      tokenAddress: TOKEN.toLowerCase(),
      amountRaw: '100000',
      amountHuman: '0.10',
      challengeId: null,
      idempotencyKey: null,
      challengePayload: null,
      confirmedAt: null,
      amountSek: null,
      fxRateSek: null,
      fxSource: null,
      fxAt: null,
      fxRates: null,
    })
    const [receipt] = (await listReceipts(agent.id, 10))!.receipts
    const status = (await getAgentPaymentStatus(agent, paymentId)) as Record<string, any>

    // Byte-equal across the two surfaces…
    expect(receipt.merchant_address).toBe(status.merchant_address)
    expect(receipt.token_address).toBe(status.asset)
    expect(receipt.parties).toEqual(status.parties)
    // …and checksummed (all-lowercase would also be byte-equal).
    expect(receipt.merchant_address).toBe(checksum(MERCHANT))
    expect(receipt.token_address).toBe(checksum(TOKEN))
    expect(receipt.parties.merchant).toBe(checksum(MERCHANT))
    // `payer_address` is excluded: the treasury on receipts, the delegate on status.
  })
})
