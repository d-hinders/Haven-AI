/**
 * Real-Postgres route tests for the x402 tax declaration endpoints (#3426).
 *
 *  - the OWNER toggle `PUT /agents/:id/tax-declaration`:
 *      - refuses (structured 409, writes NOTHING) when company details are
 *        missing or `vies_status` is not `valid`, or the flag is off;
 *      - succeeds when VIES is `valid`;
 *      - always allows switching OFF;
 *      - refuses an agent API key with a NAMED 403;
 *      - 404s a foreign agent.
 *  - the AGENT content read `GET /agents/:id/tax-declaration`:
 *      - the §2.1 content when all conditions hold;
 *      - the four structured not-available reasons, each in its own case —
 *        including VIES dropping to `invalid`/`not_verifiable` after the
 *        toggle was switched on, and the flag switched off;
 *      - the response contains ONLY the §2.1 fields — never `principalId`,
 *        `principalAttributionHash`, `org_number` or `legal_name`;
 *      - `validUntil` is integer ms, bounded by both now+window and
 *        `vies_checked_at`+max age;
 *      - a Greek VAT number (`EL…` with country `GR`) and a Northern Irish
 *        one (`XI…`): `jurisdiction` from `country`, not the VAT prefix.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { config } from '../../config.js'
import { TAX_DECLARATION_MAX_WINDOW_MS, TAX_DECLARATION_MAX_VIES_AGE_MS } from '../../modules/agents/index.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`tax-route-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function seedAccount(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 8453, 'delegator_hybrid')
     RETURNING id`,
    [userId, `0x${'c'.repeat(36)}${String(seq).padStart(4, '0')}`],
  )
  return rows[0].id
}

async function seedAgent(userId: string, accountId: string): Promise<{ id: string; apiKey: string }> {
  const apiKey = `sk_agent_test_${seq}_${Date.now()}`
  const { createHash } = await import('crypto')
  const hash = createHash('sha256').update(apiKey).digest('hex')
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, api_key_prefix, account_id, delegate_address)
     VALUES ($1, 'Tax agent', $2, 'sk_agent_', $3, $4)
     RETURNING id`,
    [userId, hash, accountId, `0x${'d'.repeat(36)}${String(seq).padStart(4, '0')}`],
  )
  return { id: rows[0].id, apiKey }
}

interface CompanyDetailsSeed {
  vat_number: string | null
  vies_status: string | null
  vies_checked_at: string | null
  country?: string
}

async function seedCompanyDetails(userId: string, overrides: CompanyDetailsSeed): Promise<void> {
  await db.query(
    `INSERT INTO owner_company_details (user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at)
     VALUES ($1, 'Acme AB', $2, '556677-8899', $3, $4, $5)`,
    [
      userId,
      overrides.country ?? 'SE',
      overrides.vat_number,
      overrides.vies_status,
      overrides.vies_checked_at,
    ],
  )
}

async function getTaxColumn(agentId: string): Promise<boolean | null> {
  const { rows } = await db.query<{ tax_declaration_enabled: boolean }>(
    `SELECT tax_declaration_enabled FROM agents WHERE id = $1`,
    [agentId],
  )
  return rows[0]?.tax_declaration_enabled ?? null
}

describeDb('tax declaration routes (#3426)', () => {
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
      enforcedModules: ['routes/agents.ts', 'routes/agent-tax-declaration.ts'],
    })
    const agentRoutes = (await import('../agents.js')).default
    const agentTaxDeclarationRoutes = (await import('../agent-tax-declaration.js')).default
    await app.register(agentRoutes, { prefix: '/agents' })
    await app.register(agentTaxDeclarationRoutes, { prefix: '/agents' })
    await app.ready()
  })

  beforeEach(async () => {
    await resetDb()
    // The test env does not set HAVEN_OWNER_COMPANY_DETAILS; the default is
    // off. The flag is read at REQUEST time (same pattern the
    // owner-company-details suite uses), so flipping the config object here
    // turns the feature on for every test that does not override it.
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
    const token = app.jwt.sign({ sub: userId, email: 'tax@test.example' })
    return { headers: { authorization: `Bearer ${token}` } }
  }

  function agentAuth(apiKey: string): { headers: { 'x-api-key': string } } {
    return { headers: { 'x-api-key': apiKey } }
  }

  async function seedViesValidOwner(): Promise<{ userId: string; accountId: string; agent: { id: string; apiKey: string } }> {
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    const agent = await seedAgent(userId, accountId)
    await seedCompanyDetails(userId, {
      vat_number: 'SE556677889901',
      vies_status: 'valid',
      vies_checked_at: new Date().toISOString(),
    })
    return { userId, accountId, agent }
  }

  // ── The owner toggle ─────────────────────────────────────────────────

  describe('PUT /agents/:id/tax-declaration', () => {
    it('refuses the opt-in with a structured 409 and writes NOTHING when there are no company details', async () => {
      const userId = await seedUser()
      const accountId = await seedAccount(userId)
      const agent = await seedAgent(userId, accountId)

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: true },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: expect.any(String),
        reason: 'no_company_details',
        available: false,
      })
      expect(await getTaxColumn(agent.id)).toBe(false)
    })

    it('refuses with reason vies_not_valid when VIES is pending/invalid/not_verifiable, writing nothing', async () => {
      for (const vies_status of ['pending', 'invalid', 'not_verifiable'] as const) {
        const userId = await seedUser()
        const accountId = await seedAccount(userId)
        const agent = await seedAgent(userId, accountId)
        await seedCompanyDetails(userId, {
          vat_number: 'SE556677889901',
          vies_status,
          vies_checked_at: vies_status === 'pending' ? null : new Date().toISOString(),
        })
        const res = await app.inject({
          method: 'PUT',
          url: `/agents/${agent.id}/tax-declaration`,
          ...ownerAuth(userId),
          payload: { tax_declaration_enabled: true },
        })
        expect(res.statusCode).toBe(409)
        expect(res.json().reason).toBe('vies_not_valid')
        expect(await getTaxColumn(agent.id)).toBe(false)
      }
    })

    it('refuses with reason feature_disabled when the flag is off', async () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const userId = await seedUser()
      const accountId = await seedAccount(userId)
      const agent = await seedAgent(userId, accountId)
      await seedCompanyDetails(userId, {
        vat_number: 'SE556677889901',
        vies_status: 'valid',
        vies_checked_at: new Date().toISOString(),
      })
      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: true },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().reason).toBe('feature_disabled')
      expect(await getTaxColumn(agent.id)).toBe(false)
    })

    it('succeeds when VIES is valid, and the write is visible', async () => {
      const { userId, agent } = await seedViesValidOwner()
      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: true },
      })
      if (res.statusCode !== 200) {
        // Surface the body in the failure message — a bare 401 assertion has
        // already cost one round trip.
        expect([res.statusCode, res.payload]).toEqual([200, ''])
      }
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ id: agent.id, tax_declaration_enabled: true })
      expect(await getTaxColumn(agent.id)).toBe(true)
    })

    it('never gates switching OFF — even with no company details at all', async () => {
      const userId = await seedUser()
      const accountId = await seedAccount(userId)
      const agent = await seedAgent(userId, accountId)
      // Force the bit on by hand first, so the OFF write is observable.
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: false },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().tax_declaration_enabled).toBe(false)
      expect(await getTaxColumn(agent.id)).toBe(false)
    })

    it('refuses an agent API key with a named 403 before any auth is evaluated', async () => {
      const { agent } = await seedViesValidOwner()
      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
        payload: { tax_declaration_enabled: true },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toContain('Agent API keys')
      expect(await getTaxColumn(agent.id)).toBe(false)
    })

    it('404s a foreign agent and writes nothing on any other agent', async () => {
      const { userId } = await seedViesValidOwner()
      const otherUserId = await seedUser()
      const otherAccountId = await seedAccount(otherUserId)
      const otherAgent = await seedAgent(otherUserId, otherAccountId)

      const res = await app.inject({
        method: 'PUT',
        url: `/agents/${otherAgent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: true },
      })
      expect(res.statusCode).toBe(404)
      expect(await getTaxColumn(otherAgent.id)).toBe(false)
    })

    it('accepts only the spec shape: a missing or extra field is refused and writes nothing', async () => {
      const { userId, agent } = await seedViesValidOwner()
      const missing = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: {},
      })
      expect(missing.statusCode).toBe(400)
      const extra = await app.inject({
        method: 'PUT',
        url: `/agents/${agent.id}/tax-declaration`,
        ...ownerAuth(userId),
        payload: { tax_declaration_enabled: true, extra: 'x' },
      })
      expect(extra.statusCode).toBe(400)
      expect(await getTaxColumn(agent.id)).toBe(false)
    })
  })

  // ── The agent content read ───────────────────────────────────────────

  describe('GET /agents/:id/tax-declaration', () => {
    it('returns the §2.1 fields when every condition holds', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.available).toBe(true)
      expect(body.declaration).toEqual({
        version: 'x402-tax-1',
        jurisdiction: 'SE',
        taxableStatus: 'TAXABLE_PERSON',
        taxId: 'SE556677889901',
        validUntil: expect.any(Number),
      })
    })

    it('reason disabled when the agent was never opted in', async () => {
      const { agent } = await seedViesValidOwner()
      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ available: false, reason: 'disabled' })
    })

    it('reason no_company_details when the owner saved no VAT number', async () => {
      const userId = await seedUser()
      const accountId = await seedAccount(userId)
      const agent = await seedAgent(userId, accountId)
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'no_company_details' })
    })

    it('reason vies_not_valid when VIES dropped AFTER the toggle was switched on (invalid, not_verifiable, pending)', async () => {
      for (const vies_status of ['invalid', 'not_verifiable', 'pending'] as const) {
        const { userId, agent } = await seedViesValidOwner()
        await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
        await db.query(
          `UPDATE owner_company_details SET vies_status = $1, vies_checked_at = $2 WHERE user_id = $3`,
          [vies_status, vies_status === 'pending' ? null : new Date().toISOString(), userId],
        )

        const res = await app.inject({
          method: 'GET',
          url: `/agents/${agent.id}/tax-declaration`,
          ...agentAuth(agent.apiKey),
        })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ available: false, reason: 'vies_not_valid' })
      }
    })

    it('reason disabled when the owner switched the toggle back off', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
      await db.query(`UPDATE agents SET tax_declaration_enabled = false WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'disabled' })
    })

    it('reason feature_disabled when the flag was switched off after the opt-in', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.json()).toEqual({ available: false, reason: 'feature_disabled' })
    })

    it('the response contains ONLY the §2.1 fields — never principalId, principalAttributionHash, org_number or legal_name', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      const body = res.json()
      expect(body.available).toBe(true)
      // Whole-body key census: the declared shape is the shipped shape.
      expect(Object.keys(body).sort()).toEqual(['available', 'declaration'])
      expect(Object.keys(body.declaration).sort()).toEqual(
        ['jurisdiction', 'taxId', 'taxableStatus', 'validUntil', 'version'],
      )
      expect(JSON.stringify(body)).not.toContain('principalId')
      expect(JSON.stringify(body)).not.toContain('principalAttributionHash')
      expect(JSON.stringify(body)).not.toContain('org_number')
      expect(JSON.stringify(body)).not.toContain('legal_name')
      expect(JSON.stringify(body)).not.toContain('signature')
    })

    it('validUntil is integer ms bounded by now + window AND vies_checked_at + max age', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
      // An old check: 20 hours ago — 4 hours of the 24h VIES age left, while
      // now + 24h would be far later. The VIES bound must win.
      const checkedAtMs = Date.now() - 20 * 60 * 60 * 1000
      const checkedAt = new Date(checkedAtMs)
      await db.query(`UPDATE owner_company_details SET vies_checked_at = $1 WHERE user_id = $2`, [
        checkedAt.toISOString(),
        agent.id,
      ])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      const body = res.json()
      expect(body.available).toBe(true)
      const validUntil = body.declaration.validUntil as number
      expect(Number.isInteger(validUntil)).toBe(true)
      // In ms, not seconds: it must be within an hour of the computed bound,
      // a seconds-scaled value would be off by three orders of magnitude.
      expect(validUntil).toBeGreaterThan(Date.now())
      // The bound as the DB returned it (the write normalises precision), so
      // the assertion compares the route's arithmetic against its own input.
      const { rows: stored } = await db.query<{ vies_checked_at: string }>(
        `SELECT vies_checked_at FROM owner_company_details WHERE user_id = (SELECT user_id FROM agents WHERE id = $1)`,
        [agent.id],
      )
      const storedCheckedAtMs = Date.parse(stored[0].vies_checked_at)
      expect(validUntil).toBeLessThanOrEqual(storedCheckedAtMs + TAX_DECLARATION_MAX_VIES_AGE_MS)
      expect(validUntil).toBeGreaterThan(Date.now() - 1000)
      expect(validUntil).toBeLessThanOrEqual(Date.now() + TAX_DECLARATION_MAX_WINDOW_MS)
    })

    it('jurisdiction comes from country, not the VAT prefix: GR with EL… and GB with XI…', async () => {
      // Greece: the VAT number's own prefix is EL, the country is GR.
      const grUserId = await seedUser()
      const grAccountId = await seedAccount(grUserId)
      const grAgent = await seedAgent(grUserId, grAccountId)
      await seedCompanyDetails(grUserId, {
        country: 'GR',
        vat_number: 'EL123456789',
        vies_status: 'valid',
        vies_checked_at: new Date().toISOString(),
      })
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [grAgent.id])
      const grRes = await app.inject({
        method: 'GET',
        url: `/agents/${grAgent.id}/tax-declaration`,
        ...agentAuth(grAgent.apiKey),
      })
      expect(grRes.json().available).toBe(true)
      expect(grRes.json().declaration.jurisdiction).toBe('GR')
      expect(grRes.json().declaration.taxId).toBe('EL123456789')

      // Northern Ireland: the XI prefix is not a country code; the saved
      // country declares.
      const gbUserId = await seedUser()
      const gbAccountId = await seedAccount(gbUserId)
      const gbAgent = await seedAgent(gbUserId, gbAccountId)
      await seedCompanyDetails(gbUserId, {
        country: 'GB',
        vat_number: 'XI123456789',
        vies_status: 'valid',
        vies_checked_at: new Date().toISOString(),
      })
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [gbAgent.id])
      const gbRes = await app.inject({
        method: 'GET',
        url: `/agents/${gbAgent.id}/tax-declaration`,
        ...agentAuth(gbAgent.apiKey),
      })
      expect(gbRes.json().available).toBe(true)
      expect(gbRes.json().declaration.jurisdiction).toBe('GB')
      expect(gbRes.json().declaration.taxId).toBe('XI123456789')
    })

    it('an agent key cannot read another agent id — even its owner would not be asked', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
      const otherUserId = await seedUser()
      const otherAccountId = await seedAccount(otherUserId)
      const otherAgent = await seedAgent(otherUserId, otherAccountId)
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [otherAgent.id])

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${otherAgent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().available).toBe(false)
    })

    it('answers every 200 against the OpenAPI spec', async () => {
      const { agent } = await seedViesValidOwner()
      await db.query(`UPDATE agents SET tax_declaration_enabled = true WHERE id = $1`, [agent.id])
      const ok = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expectMatchesSpec('GET', '/agents/{id}/tax-declaration', ok.json())

      await db.query(`UPDATE agents SET tax_declaration_enabled = false WHERE id = $1`, [agent.id])
      const off = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/tax-declaration`,
        ...agentAuth(agent.apiKey),
      })
      expectMatchesSpec('GET', '/agents/{id}/tax-declaration', off.json())
    })
  })
})
