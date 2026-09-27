/**
 * #3332 review M2 — the `parties.buyer` FLAG WIRING in `modules/mpp/evidence.ts`
 * (`mapEvidence` / `listReceipts`), on the real DB end-to-end, not just
 * `buyerPartyFromJoin`'s own pure unit test (`infra/repositories/__tests__/
 * owner-company-details.test.ts`). Mutation-proven: replacing
 * `config.ownerCompanyDetailsEnabled` with a literal `true` at `mapEvidence`'s
 * own call site would make the "flag off" case below fail.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { upsertEvidenceBase } from '../../../infra/repositories/machine-payments.js'
import { upsertOwnerCompanyDetails } from '../../../infra/repositories/owner-company-details.js'
import { config } from '../../../config.js'
import { listReceipts } from '../evidence.js'

let seq = 0

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ebf-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'machine agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

async function seedIntent(agentId: string, userId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, payment_rail)
     VALUES ($1, $2, '0x00000000000000000000000000000000000001', 'USDC',
             '0x00000000000000000000000000000000000002', '0x00000000000000000000000000000000000003',
             '100000', '0.10', '0x00000000000000000000000000000000000004', 1, $3,
             'confirmed', NOW() + interval '10 minutes', 'mpp')
     RETURNING id`,
    [agentId, userId, `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66)],
  )
  return r.rows[0].id
}

async function seedEvidence(agent: { agentId: string; userId: string }, intentId: string): Promise<void> {
  await upsertEvidenceBase({
    paymentIntentId: intentId,
    approvalRequestId: null,
    agentId: agent.agentId,
    userId: agent.userId,
    rail: 'mpp',
    txHash: `0x${'a'.repeat(64)}`,
    chainId: 84532,
    resourceUrl: 'https://merchant.example/r',
    merchantAddress: '0x00000000000000000000000000000000000005',
    payerAddress: '0x00000000000000000000000000000000000001',
    settlementAddress: '0x00000000000000000000000000000000000006',
    tokenSymbol: 'USDC',
    tokenAddress: '0x00000000000000000000000000000000000002',
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
}

describeDb('parties.buyer flag wiring — modules/mpp/evidence.ts (#3332 review M2)', () => {
  const originalFlag = config.ownerCompanyDetailsEnabled

  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(() => {
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = originalFlag
  })

  it('flag OFF: parties has no "buyer" key, even when the owner has saved details', async () => {
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await seedEvidence(agent, intentId)
    await upsertOwnerCompanyDetails(agent.userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })

    const [receipt] = (await listReceipts(agent.agentId, 10))!.receipts
    expect('buyer' in (receipt.parties as unknown as Record<string, unknown>)).toBe(false)
  })

  it('flag ON: parties.buyer is present and correct', async () => {
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await seedEvidence(agent, intentId)
    await upsertOwnerCompanyDetails(agent.userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })

    const [receipt] = (await listReceipts(agent.agentId, 10))!.receipts
    expect((receipt.parties as { buyer?: Record<string, unknown> }).buyer).toMatchObject({
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
    })
  })

  it('flag ON but no saved details: still no "buyer" key', async () => {
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
    const agent = await seedAgent()
    const intentId = await seedIntent(agent.agentId, agent.userId)
    await seedEvidence(agent, intentId)

    const [receipt] = (await listReceipts(agent.agentId, 10))!.receipts
    expect('buyer' in (receipt.parties as unknown as Record<string, unknown>)).toBe(false)
  })
})
