/**
 * Igdrasil's dedup against the REAL receipt renderer (#4518, epic #2875).
 *
 * Igdrasil keys a document on its BYTES: the same file uploads as the same
 * document (200), a different file as a new one (201). The connector sends
 * no idempotency key, so a re-push of a payment creates no second document
 * only if the underlag renders byte-identical on every attempt — and two
 * payments only stay two documents if their renders differ. The conformance
 * suite stubs the underlag (bytes carrying the payment id, by assumption);
 * this file drops that stub and proves both halves on the real
 * `loadReceiptUnderlag` → `underlagFromData` path, reading a seeded
 * `machine_payment_evidence` row on the real database.
 *
 * Real: the connector, the generic OAuth2 connect (PKCE on), the token store,
 * the underlag SQL and renderer. Stubbed: only `fetch` (the shared
 * `igdrasil-test-router.ts`).
 */
import { vi } from 'vitest'

vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      igdrasilClientId: 'igd_app_fixture',
      igdrasilClientSecret: 'igd_cs_fixture',
      igdrasilRedirectUri: 'https://api.test/accounting/connections/igdrasil/callback',
    },
  }
})

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { IgdrasilConnector } from '../igdrasil-connector.js'
import { igdrasilOAuth2Config } from '../igdrasil.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { pkceVerifierFor } from '../oauth-pkce.js'
import { loadReceiptUnderlag } from '../receipt-underlag.js'
import { IGDRASIL } from '../registry.js'
import { feedTransaction } from './connector-conformance.js'
import { IGDRASIL_DOCUMENT_ID, IGDRASIL_MERCHANT_DOCUMENT_ID, igdrasilRouter } from './igdrasil-test-router.js'

const KEY = randomBytes(32).toString('base64')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

let seq = 0
async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [
    `igdrasil-feed-db-${++seq}-${Date.now()}@test.example`,
  ])
  const agent = await db.query<{ id: string }>(`INSERT INTO agents (user_id, name) VALUES ($1, 'igdrasil feed agent') RETURNING id`, [
    user.rows[0].id,
  ])
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * One settled x402 payment: the confirmed intent and its evidence row (the
 * evidence names exactly one payment reference — the intent). The evidence
 * id is what `receiptRef` names; the intent contributes the authorization
 * lines the renderer joins in.
 */
async function seedEvidence(userId: string, agentId: string): Promise<string> {
  const n = ++seq
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, confirmed_at, expires_at,
       chain_id, source, execution_rail, x402_resource_url, merchant_address
     ) VALUES (
       $1, $2, $3, 'USDC', '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       $4, '1000', '0.001', '0x00000000000000000000000000000000000000d1',
       $5, $6, 'confirmed', NOW(), NOW() + INTERVAL '10 minutes',
       84532, 'mcp', 'delegation', 'https://merchant.example/vpn', $4
     ) RETURNING id`,
    [agentId, userId, `0x${String(2e12 + n).padStart(40, '0').slice(-40)}`, '0x' + 'ab'.repeat(20), n, `0x${String(n).padStart(64, 'c')}`],
  )
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
       resource_url, payer_address, settlement_address, token_symbol, token_address,
       amount_raw, amount_human
     ) VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 84532,
       'https://merchant.example/vpn', $5, $5, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '1000', '0.001')
     RETURNING id`,
    [intent.rows[0].id, agentId, userId, `0x${randomUUID().replaceAll('-', '')}`, '0x' + 'ab'.repeat(20)],
  )
  return rows[0].id
}

describeDb('Igdrasil byte-keyed dedup on the real receipt renderer (#4518)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    process.env[SECRETS_KEY_ENV] = KEY
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  async function connected() {
    const { userId, agentId } = await seedUser()
    const router = igdrasilRouter()
    const connector = new IgdrasilConnector(router.impl)
    registerConnector(connector)
    await completeOAuth2Connect({
      provider: IGDRASIL,
      cfg: igdrasilOAuth2Config({ clientId: 'igd_app_fixture', clientSecret: 'igd_cs_fixture', redirectUri: 'https://api.test/cb' }),
      connector,
      userId,
      code: 'auth-code',
      pkceVerifier: pkceVerifierFor('feed-db-jti', 'feed-db-key'),
      fetchImpl: router.impl,
    })
    return { userId, agentId, connector, state: router.state }
  }

  it('a re-push of the same payment renders the same bytes, so Igdrasil names the SAME document and creates none', async () => {
    const { userId, agentId, connector, state } = await connected()
    const evidenceId = await seedEvidence(userId, agentId)
    const tx = feedTransaction(`pay-igd-feed-db-${seq}-1`, { receiptRef: evidenceId })

    // The renderer really reads the seeded row: a real PDF, not a stub.
    const rendered = await loadReceiptUnderlag(userId, tx)
    expect(rendered?.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const first = await connector.pushTransaction(userId, tx)
    const second = await connector.pushTransaction(userId, tx)
    expect(first).toEqual({ externalRef: `igdrasil:document:${IGDRASIL_DOCUMENT_ID}`, status: 'pushed' })
    expect(second).toEqual(first)
    expect(state.uploads).toHaveLength(2)
    expect(state.uploads[1].sha256).toBe(state.uploads[0].sha256)
    expect(state.uploads[0].sha256).toBe(sha(rendered!.pdf))
    expect(state.uploadCalls).toBe(1)
  })

  it('two payments render different bytes, so they stay two documents', async () => {
    const { userId, agentId, connector, state } = await connected()
    const a = feedTransaction(`pay-igd-feed-db-${seq}-a`, { receiptRef: await seedEvidence(userId, agentId) })
    const b = feedTransaction(`pay-igd-feed-db-${seq}-b`, { receiptRef: await seedEvidence(userId, agentId) })

    const ra = await connector.pushTransaction(userId, a)
    const rb = await connector.pushTransaction(userId, b)
    expect(ra.externalRef).toBe(`igdrasil:document:${IGDRASIL_DOCUMENT_ID}`)
    expect(rb.externalRef).toBe(`igdrasil:document:${IGDRASIL_MERCHANT_DOCUMENT_ID}`)
    expect(state.uploads[0].sha256).not.toBe(state.uploads[1].sha256)
    expect(state.uploadCalls).toBe(2)
  })
})
