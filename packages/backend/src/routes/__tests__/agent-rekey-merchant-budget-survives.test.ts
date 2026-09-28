/**
 * #3386 — a merchant-locked budget must still be listed by
 * `GET /merchants/{slug}/budgets` after a re-key completes.
 *
 * Real-Postgres, exercising the actual repository functions the route uses
 * (`openRekey`, `markRevoked`, `markMetered`, `findDelegationTerms`,
 * `insertRekeyDelegation`, `activateRekeyDelegation`, `completeRekey`) against
 * a merchant-locked seed row, then reading the result back through the real
 * `GET /merchants/{slug}/budgets` handler — the actual consumer named in the
 * issue. On-chain effects (the owner-signed revoke/issue userOps) are outside
 * this route's own storage and are exercised by the mocked route suites
 * (`agent-rekey-issue-merchant-label.test.ts`,
 * `agent-rekey-revoke-submit.test.ts`); this file proves what Postgres holds
 * after the write functions those routes call run for real.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { findOrCreateMerchantByHost } from '../../infra/repositories/merchants.js'
import merchantRoutes from '../merchants.js'
import {
  completeRekey,
  findDelegationTerms,
  insertRekeyDelegation,
  markIssued,
  markMetered,
  markRevoked,
  nextDelegationVersion,
  openRekey,
  type CarrySnapshotEntry,
} from '../../infra/repositories/agent-rekeys.js'
import { revokeDelegationsByHashes } from '../../infra/repositories/delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const OLD_DELEGATE = '0x00000000000000000000000000000000000000d1'
const NEW_DELEGATE = '0x00000000000000000000000000000000000000d2'
const PAY_TO = '0x' + 'aa'.repeat(20)

let seq = 0

async function insertOffer(merchantId: string, resourceUrl: string, network: string): Promise<void> {
  seq += 1
  await db.query(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, tool_name, network, status,
        verified_at, merchant_id, pay_to, asset_transfer_methods)
     VALUES ($1, 'x', 'api', $2, 'x402', 'http', NULL, $3, 'active', NOW(), $4, $5, 'eip3009,erc7710')`,
    [`offer-${seq}`, resourceUrl, network, merchantId, PAY_TO],
  )
}

describeDb('a merchant-locked budget survives a re-key (#3386)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(merchantRoutes, { prefix: '/merchants' })
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function userHeaders(userId: string): Record<string, string> {
    return { authorization: `Bearer ${app.jwt.sign({ sub: userId, email: 'u@test.dev' })}` }
  }

  async function seedAgent(): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`rk-merchant-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const safe = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Rekey agent', $3, $4, 'sk_agent_old', 'active') RETURNING id`,
      [userId, safe.rows[0].id, OLD_DELEGATE, `hash-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  async function seedMerchantLockedDelegation(agentId: string, merchantId: string): Promise<string> {
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds, start_date,
          expires_at, merchant_id)
       VALUES ($1, 84532, $2, $3, $4, '{"signed":"capability"}', 1, 'active', '5000000',
               86400, 0, 1900000000, $5)`,
      [agentId, USDC, PAY_TO, hash, merchantId],
    )
    return hash
  }

  it('lists the budget under the merchant after the re-key completes, still pinned and still labelled', async () => {
    const merchant = await findOrCreateMerchantByHost('rekey-merchant.example', { name: 'Rekey Merchant' })
    await insertOffer(merchant.id, 'https://rekey-merchant.example/a', 'eip155:84532')

    const { userId, agentId } = await seedAgent()
    const oldHash = await seedMerchantLockedDelegation(agentId, merchant.id)

    // ── Revoke: the old row retires, the same way the route does it ───────
    const rekey = await openRekey({
      agentId,
      userId,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      residualAtomic: '0',
      residualTokenAddress: null,
      residualDisposition: 'none',
    })
    await revokeDelegationsByHashes(agentId, [oldHash])
    await markRevoked(rekey.id, agentId, '0xrevoketx')

    // ── Meter: the snapshot carries the merchant_id read off the old row,
    //    exactly as the route's revoke/submit handler does (#3386) ─────────
    const oldTerms = await findDelegationTerms(agentId, oldHash)
    expect(oldTerms?.merchant_id).toBe(merchant.id)
    const snapshot: CarrySnapshotEntry[] = [
      {
        delegation_hash: oldHash,
        token_address: USDC,
        recipient_address: PAY_TO,
        budget_atomic: '5000000',
        period_seconds: 86_400,
        start_date: 0,
        expires_at: 1_900_000_000,
        remaining_atomic: '3000000',
        from_chain: true,
        merchant_id: oldTerms?.merchant_id ?? null,
      },
    ]
    await markMetered(rekey.id, agentId, snapshot)

    // ── Issue: one steady replacement, carrying the label (#3386) ─────────
    const version = await nextDelegationVersion(agentId, USDC, PAY_TO)
    const newHash = `0x${String(++seq).padStart(64, '0')}`
    const inserted = await insertRekeyDelegation({
      agentId,
      userId,
      chainId: 84532,
      tokenAddress: USDC,
      recipientAddress: PAY_TO,
      delegationHash: newHash,
      delegationJson: '{"signed":"capability-v2"}',
      version,
      budgetAtomic: '5000000',
      periodSeconds: 86_400,
      startDate: 0,
      expiresAt: 1_900_000_000,
      rekeyId: rekey.id,
      carryRole: 'steady',
      merchantId: snapshot[0].merchant_id ?? null,
    })
    expect(inserted).toBe(true)
    const issued = await markIssued(rekey.id, agentId)
    expect(issued?.stage).toBe('issued')

    // ── Complete: activate + rotate credentials, one transaction ──────────
    const row = await db.query<{ id: string }>(
      `SELECT id FROM agent_delegations WHERE delegation_hash = $1`,
      [newHash],
    )
    await completeRekey({
      agentId,
      userId,
      rekeyId: rekey.id,
      oldDelegateAddress: OLD_DELEGATE,
      newDelegateAddress: NEW_DELEGATE,
      apiKeyHash: 'hash-new',
      apiKeyPrefix: 'sk_agent_new',
      signedDelegations: [{ id: row.rows[0].id, delegationJson: '{"signed":"capability-v2","final":true}' }],
    })

    // ── Read: the actual consumer this issue is about ──────────────────────
    const res = await app.inject({
      method: 'GET',
      url: '/merchants/rekey-merchant/budgets',
      headers: userHeaders(userId),
    })
    expect(res.statusCode).toBe(200)
    const budgets = res.json().budgets as Array<Record<string, unknown>>
    expect(budgets).toHaveLength(1)
    expect(budgets[0]).toMatchObject({
      agent_id: agentId,
      recipient_address: PAY_TO,
      budget_atomic: '5000000',
      pin_status: 'current',
    })

    // The activated replacement carries the label at the storage layer too.
    const stored = await db.query<{ merchant_id: string; status: string; carry_role: string }>(
      `SELECT merchant_id, status, carry_role FROM agent_delegations WHERE delegation_hash = $1`,
      [newHash],
    )
    expect(stored.rows[0].merchant_id).toBe(merchant.id)
    expect(stored.rows[0].status).toBe('active')
    expect(stored.rows[0].carry_role).toBe('steady')

    // The OLD row is retired and no longer the one satisfying the read.
    const old = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE delegation_hash = $1`,
      [oldHash],
    )
    expect(old.rows[0].status).toBe('revoked')
  })
})
