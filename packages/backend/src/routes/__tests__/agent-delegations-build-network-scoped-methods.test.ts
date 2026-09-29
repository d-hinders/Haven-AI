/**
 * #3386 — `asset_transfer_methods` must reflect only the `accepts[]` options
 * on an offer's own RECORDED network, and that has to reach the actual
 * refusal a merchant-locked build makes, not just the probe's return value.
 *
 * Real-Postgres, unmocked `merchants` repository and delegation-build route:
 * `refreshCatalog` runs against a genuine two-network x402 challenge (EIP-3009
 * on `eip155:84532`, ERC-7710 only on `eip155:8453`) the same way the catalog
 * cron does, and the assertions are on what `POST /:id/delegations/build`
 * does next — the build route's 409 on the 84532 agent, and that the SAME
 * merchant's offer set lets an 8453 agent past the ERC-7710 gate. Before
 * #3386, the union recorded on the 84532 row (`eip3009,erc7710`) would have
 * let this build through and issued a budget the merchant can never actually
 * pay through ERC-7710 there.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { findOrCreateMerchantByHost } from '../../infra/repositories/merchants.js'
import { refreshCatalog } from '../../modules/catalog/merchant-catalog.js'
import agentDelegationRoutes from '../agent-delegations.js'

const PAY_TO = '0x' + 'aa'.repeat(20)

let seq = 0

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

/** A challenge whose accepts[0] names 84532 with only EIP-3009, and whose
 * second option names 8453 with ERC-7710. */
const TWO_NETWORK_CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '20000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    },
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '20000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'erc7710' },
    },
  ],
}

describeDb('a two-network x402 challenge drives the build route (#3386)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
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

  async function seedAgent(chainId: number): Promise<{ userId: string; agentId: string }> {
    const n = ++seq
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`build-network-${n}-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const safe = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
      [userId, `0x${String(n).padStart(40, 'a')}`, chainId],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'Build agent', $3, $4, 'sk_agent_x', 'active') RETURNING id`,
      [userId, safe.rows[0].id, `0x${String(n).padStart(40, 'b')}`, `hash-${n}-${Date.now()}`],
    )
    return { userId, agentId: agent.rows[0].id }
  }

  it("scopes the recorded row's method set to its own network, and the build route refuses the network that lacks erc7710 while accepting the one that has it", async () => {
    const merchant = await findOrCreateMerchantByHost('two-network.example', { name: 'Two Network' })
    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name, status, merchant_id)
       VALUES ('offer', 'x', 'api', 'https://two-network.example/pay', 'x402', 'http', NULL, 'active', $1)`,
      [merchant.id],
    )

    const fetchMock = async () =>
      new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': b64(TWO_NETWORK_CHALLENGE) } })
    const result = await refreshCatalog(db, fetchMock as unknown as typeof fetch)
    expect(result.verified).toBe(1)

    const row = await db.query<{ network: string; asset_transfer_methods: string }>(
      `SELECT network, asset_transfer_methods FROM merchant_catalog WHERE merchant_id = $1`,
      [merchant.id],
    )
    // The row is recorded on accepts[0]'s network — MUTATION TARGET: without
    // #3386's network scoping this would read 'eip3009,erc7710' (the union).
    expect(row.rows[0].network).toBe('eip155:84532')
    expect(row.rows[0].asset_transfer_methods).toBe('eip3009')

    // A second offer, ERC-7710 on 8453 only, so the 8453 agent has a live
    // target to build against too.
    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name, status, merchant_id,
          network, pay_to, asset_transfer_methods, verified_at)
       VALUES ('offer-8453', 'x', 'api', 'https://two-network.example/pay8453', 'x402', 'http', NULL, 'active',
               $1, 'eip155:8453', $2, 'erc7710', NOW())`,
      [merchant.id, PAY_TO],
    )

    const { userId: userOn84532, agentId: agentOn84532 } = await seedAgent(84532)
    const build84532 = await app.inject({
      method: 'POST',
      url: `/agents/${agentOn84532}/delegations/build`,
      headers: userHeaders(userOn84532),
      payload: {
        token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        budget_atomic: '1000000',
        period_seconds: 86_400,
        merchant_slug: 'two-network',
      },
    })
    // Driven all the way to the ROUTE's refusal — not just the probe's
    // return value — because the merchant's only 84532 offer no longer
    // reads as ERC-7710-capable there.
    expect(build84532.statusCode).toBe(409)
    expect(build84532.json().error).toMatch(/ERC-7710/)

    const { userId: userOn8453, agentId: agentOn8453 } = await seedAgent(8453)
    const build8453 = await app.inject({
      method: 'POST',
      url: `/agents/${agentOn8453}/delegations/build`,
      headers: userHeaders(userOn8453),
      payload: {
        token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        budget_atomic: '1000000',
        period_seconds: 86_400,
        merchant_slug: 'two-network',
      },
    })
    // Same merchant, same review cycle — the OTHER network still builds,
    // proving the narrowing did not strand every network, only the one whose
    // own challenge lacks ERC-7710.
    expect(build8453.statusCode).not.toBe(409)
  })
})
