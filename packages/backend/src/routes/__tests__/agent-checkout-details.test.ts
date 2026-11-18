/**
 * Real-Postgres route tests for the per-agent checkout-details sharing switch
 * and the agent's read (#4871, epic #4868).
 *
 *  - the OWNER toggle `PUT /agents/:id/checkout-details-sharing`:
 *      - succeeds with the flag on, even when NOTHING is stored (the switch
 *        may be on with nothing saved — issue #4871);
 *      - refuses with a structured 409 (`feature_disabled`) when the flag is
 *        off, writing NOTHING;
 *      - always allows switching OFF;
 *      - refuses an agent API key with a NAMED 403;
 *      - 404s a foreign agent;
 *      - accepts only the spec shape (missing/extra field → 400).
 *  - the AGENT read `GET /agents/:id/checkout-details`:
 *      - the stored receipt email, billing address and shipping address when
 *        the switch is on, under the names and address shape
 *        `docs/architecture/13-checkout-details.md` §2 decides;
 *      - `available: false` with `disabled`, `no_details` and
 *        `feature_disabled`, each in its own case;
 *      - sharing on with NO receipt email saved → the read has NO email
 *        (never the sign-up email);
 *      - a field the owner has not saved is omitted, never `null`;
 *      - the switch is independent of the tax declaration switch, in BOTH
 *        directions;
 *      - an agent key cannot read another agent's id (403).
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { config } from '../../config.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`checkout-route-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAccount(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 8453, 'delegator_hybrid')
     RETURNING id`,
    [userId, `0x${'f'.repeat(36)}${String(seq).padStart(4, '0')}`],
  )
  return rows[0].id
}

async function seedAgent(userId: string, accountId: string): Promise<{ id: string; apiKey: string }> {
  const apiKey = `sk_agent_${seq}_${Date.now()}`
  const { createHash } = await import('crypto')
  const hash = createHash('sha256').update(apiKey).digest('hex')
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, api_key_prefix, account_id, delegate_address)
     VALUES ($1, 'Checkout agent', $2, 'sk_agent_', $3, $4)
     RETURNING id`,
    [userId, hash, accountId, `0x${'a'.repeat(36)}${String(seq).padStart(4, '0')}`],
  )
  return { id: rows[0].id, apiKey }
}

interface CompanyDetailsSeed {
  receipt_email?: string | null
  billing_address?: unknown
  shipping_address?: unknown
}

async function seedCompanyDetails(userId: string, overrides: CompanyDetailsSeed = {}): Promise<void> {
  await db.query(
    `INSERT INTO owner_company_details
       (user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at,
        receipt_email, billing_address, shipping_address)
     VALUES ($1, 'Acme AB', 'SE', '556677-8899', 'SE556677889901', 'valid', $2, $3, $4, $5)`,
    [
      userId,
      new Date().toISOString(),
      overrides.receipt_email ?? null,
      overrides.billing_address === undefined ? null : JSON.stringify(overrides.billing_address),
      overrides.shipping_address === undefined ? null : JSON.stringify(overrides.shipping_address),
    ],
  )
}

async function getSharingColumn(agentId: string): Promise<boolean | null> {
  const { rows } = await db.query<{ checkout_details_sharing_enabled: boolean }>(
    `SELECT checkout_details_sharing_enabled FROM agents WHERE id = $1`,
    [agentId],
  )
  return rows[0]?.checkout_details_sharing_enabled ?? null
}

const BILLING = {
  line1: 'Sveavagen 1',
  line2: '4 tr',
  city: 'Stockholm',
  postCode: '111 57',
  subdivision: 'SE-AB',
  country: 'SE',
}

const SHIPPING = { line1: 'Storgatan 2', city: 'Goteborg', country: 'SE' }

describeDb('checkout-details sharing routes (#4871)', () => {
  let app: FastifyInstance
  const originalFlag = config.ownerCompanyDetailsEnabled

  beforeAll(async () => {
    await initDbHarness()

    app = Fastify({ logger: false })
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      void reply.status(error.statusCode ?? 500).send({ error: error.message })
    })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, {
      mode: 'enforce',
      enforcedModules: [
        'routes/agents.ts',
        'routes/agent-checkout-details.ts',
        'routes/agent-tax-declaration.ts',
      ],
    })
    const agentRoutes = (await import('../agents.js')).default
    const agentCheckoutDetailsRoutes = (await import('../agent-checkout-details.js')).default
    // The independence case reads the tax declaration route too, so the two
    // switches are proven independent end to end rather than at the column.
    const agentTaxDeclarationRoutes = (await import('../agent-tax-declaration.js')).default
    await app.register(agentRoutes, { prefix: '/agents' })
    await app.register(agentCheckoutDetailsRoutes, { prefix: '/agents' })
    await app.register(agentTaxDeclarationRoutes, { prefix: '/agents' })
    await app.ready()
  })

  beforeEach(async () => {
    await resetDb()
    // The test env does not set HAVEN_OWNER_COMPANY_DETAILS; the default is
    // off. The flag is read at REQUEST time, so flipping the config object
    // here turns the feature on for every test that does not override it.
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
  })

  afterEach(async () => {
    ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = originalFlag
  })

  afterAll(async () => {
    await app.close()
    await assertWorkerSchemaAtHead()
  })

  function ownerAuth(userId: string): { headers: { authorization: string } } {
    const token = app.jwt.sign({ sub: userId, email: 'checkout@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  function agentAuth(apiKey: string): { headers: { 'x-api-key': string } } {
    return { headers: { 'x-api-key': apiKey } }
  }

  async function seedOwnerWithAgent(): Promise<{
    userId: string
    accountId: string
    agent: { id: string; apiKey: string }
  }> {
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    const agent = await seedAgent(userId, accountId)
    return { userId, accountId, agent }
  }

  // ── The owner toggle ─────────────────────────────────────────────────

  describe('PUT /agents/:id/checkout-details-sharing', () => {
    it('succeeds with the flag on, even when NOTHING is stored', async () => {
      const { userId, agent } = await seedOwnerWithAgent()

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: { checkout_details_sharing_enabled: true },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ id: agent.id, checkout_details_sharing_enabled: true })
      expect(await getSharingColumn(agent.id)).toBe(true)
    })

    it('refuses with reason feature_disabled when the flag is off, writing nothing', async () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const { userId, agent } = await seedOwnerWithAgent()

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: { checkout_details_sharing_enabled: true },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: expect.any(String),
        reason: 'feature_disabled',
        available: false,
      })
      expect(await getSharingColumn(agent.id)).toBe(false)
    })

    it('never gates switching OFF — even with the flag off', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: { checkout_details_sharing_enabled: false },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().checkout_details_sharing_enabled).toBe(false)
      expect(await getSharingColumn(agent.id)).toBe(false)
    })

    it('refuses an agent API key with a named 403 before any auth is evaluated', async () => {
      const { agent } = await seedOwnerWithAgent()
      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...agentAuth(agent.apiKey),
        payload: { checkout_details_sharing_enabled: true },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toContain('Agent API keys')
      expect(await getSharingColumn(agent.id)).toBe(false)
    })

    it('404s a foreign agent and writes nothing on any other agent', async () => {
      const { userId } = await seedOwnerWithAgent()
      const otherUserId = await seedUser()
      const otherAccountId = await seedAccount(otherUserId)
      const otherAgent = await seedAgent(otherUserId, otherAccountId)

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${otherAgent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: { checkout_details_sharing_enabled: true },
      })
      expect(res.statusCode).toBe(404)
      expect(await getSharingColumn(otherAgent.id)).toBe(false)
    })

    it('accepts only the spec shape: a missing or extra field is refused and writes nothing', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      const missing = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: {},
      })
      expect(missing.statusCode).toBe(400)
      const extra = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/checkout-details-sharing`,
        ...ownerAuth(userId),
        payload: { checkout_details_sharing_enabled: true, extra: 'x' },
      })
      expect(extra.statusCode).toBe(400)
      expect(await getSharingColumn(agent.id)).toBe(false)
    })
  })

  // ── The agent read ───────────────────────────────────────────────────

  describe('GET /agents/:id/checkout-details', () => {
    it('returns the stored receipt email and both addresses when the switch is on', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, {
        receipt_email: 'billing@acme.se',
        billing_address: BILLING,
        shipping_address: SHIPPING,
      })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        available: true,
        checkout_details: {
          receipt_email: 'billing@acme.se',
          billing_address: BILLING,
          shipping_address: SHIPPING,
        },
      })
      expectMatchesSpec('GET', '/agents/{id}/checkout-details', res.json())
    })

    it('reason disabled when the owner never turned sharing on', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { receipt_email: 'billing@acme.se' })

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'disabled' })
      expectMatchesSpec('GET', '/agents/{id}/checkout-details', res.json())
    })

    it('reason disabled when the owner switched sharing back off', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { receipt_email: 'billing@acme.se' })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = false WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'disabled' })
    })

    it('reason no_details when sharing is on but nothing is stored', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId)
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'no_details' })
      expectMatchesSpec('GET', '/agents/{id}/checkout-details', res.json())
    })

    it('reason no_details when the owner has no company-details row at all', async () => {
      const { agent } = await seedOwnerWithAgent()
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'no_details' })
    })

    it('reason feature_disabled when the flag was switched off after sharing was turned on', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { receipt_email: 'billing@acme.se' })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'feature_disabled' })
      expectMatchesSpec('GET', '/agents/{id}/checkout-details', res.json())
    })

    it('sharing on with NO receipt email saved → the read has NO email (never the sign-up email)', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { billing_address: BILLING })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      const body = res.json()
      expect(body.available).toBe(true)
      expect(body.checkout_details).not.toHaveProperty('receipt_email')
      expect(body.checkout_details.billing_address).toEqual(BILLING)
      // The owner's sign-up email is never a fallback.
      const { rows } = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])
      expect(JSON.stringify(body)).not.toContain(rows[0].email)
    })

    it('omits a field the owner has not saved — never `null`', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { receipt_email: 'billing@acme.se', shipping_address: SHIPPING })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      const body = res.json()
      expect(body.checkout_details).not.toHaveProperty('billing_address')
      expect(body.checkout_details.shipping_address).toEqual(SHIPPING)
      expect(JSON.stringify(body)).not.toContain('null')
    })

    it('the switch is independent of the tax declaration switch, in BOTH directions', async () => {
      const { userId, agent } = await seedOwnerWithAgent()
      await seedCompanyDetails(userId, { receipt_email: 'billing@acme.se' })

      // Sharing ON, tax declaration OFF.
      await db.query(
        `UPDATE agents SET checkout_details_sharing_enabled = true, tax_declaration_enabled = false WHERE id = $1`,
        [agent.id],
      )
      const sharingOnly = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(sharingOnly.json().available).toBe(true)
      const taxOff = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(taxOff.json()).toEqual({ available: false, reason: 'disabled' })

      // Tax declaration ON, sharing OFF.
      await db.query(
        `UPDATE agents SET checkout_details_sharing_enabled = false, tax_declaration_enabled = true WHERE id = $1`,
        [agent.id],
      )
      const sharingOff = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(sharingOff.json()).toEqual({ available: false, reason: 'disabled' })
      const taxOn = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(taxOn.json().available).toBe(true)
    })

    it('an agent key cannot read another agent id', async () => {
      const { agent } = await seedOwnerWithAgent()
      const otherUserId = await seedUser()
      const otherAccountId = await seedAccount(otherUserId)
      const otherAgent = await seedAgent(otherUserId, otherAccountId)
      await seedCompanyDetails(otherUserId, { receipt_email: 'other@acme.se' })
      await db.query(`UPDATE agents SET checkout_details_sharing_enabled = true WHERE id = $1`, [otherAgent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${otherAgent.id}/checkout-details`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().available).toBe(false)
      expect(JSON.stringify(res.json())).not.toContain('other@acme.se')
    })

    it('an unauthenticated caller gets 401', async () => {
      const { agent } = await seedOwnerWithAgent()
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/checkout-details`,
      })
      expect(res.statusCode).toBe(401)
    })
  })
})
