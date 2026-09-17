/**
 * Accounted connect, on the REAL database (#3017, epic #3016) — the first
 * live provider through the generic API-key flow (`api-key-flow.ts` had no
 * live-provider exercise before this). Real flow, real repositories, real
 * AES-GCM secrets envelope, real orchestrator-free connect; the provider is a
 * fixture `fetch` (the LIVE-recorded fixtures under `fixtures/accounted/`).
 *
 * Proven here, per the acceptance list:
 *  - the key is stored ENCRYPTED (ciphertext at rest, decrypt round-trips)
 *    and is NEVER echoed by anything a user can read back (the row, the
 *    summary, the error bodies);
 *  - the connection books in SEK — `base_currency` is stored NULL (the
 *    provider read exposes no currency) and `ledgerCurrencyOrDefault(null)`
 *    is `DEFAULT_LEDGER_CURRENCY` ('SEK');
 *  - the company identity lands on the row (`external_company_id` = the
 *    provider UUID — conformance case 8's company-switch detection keys on
 *    it);
 *  - a multi-company key and a refused key store NOTHING.
 *
 * Mutation targets, each named at its site: storing plaintext instead of
 * ciphertext (the ciphertext assertions go red); the connector's
 * MultiCompanyKeyError branch (the multi case); the flow's 401→
 * `InvalidApiKeyError` translation (the refused case).
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { SECRETS_KEY_ENV, decryptSecrets } from '../../../infra/secrets.js'
import { getConnection } from '../../../infra/repositories/accounting-connections.js'
import { AccountedConnector, MultiCompanyKeyError } from '../accounted-connector.js'
import { connectWithApiKey, InvalidApiKeyError, type ApiKeySecrets } from '../api-key-flow.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { toConnectionSummary } from '../connections.js'
import { ledgerCurrencyOrDefault } from '../../../domain/ledger-currency.js'
import { ACCOUNTED } from '../registry.js'

const KEY = randomBytes(32).toString('base64')

let seq = 0

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`accounted-db-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/accounted/${name}`, import.meta.url), 'utf8'))
}

/** A connector whose provider answers every companies call with the given body. */
function connectorAnswering(body: unknown, status = 200): AccountedConnector {
  const impl = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  return new AccountedConnector(impl)
}

describeDb('Accounted connectWithApiKey on the real database (#3017)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    process.env[SECRETS_KEY_ENV] = KEY
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  it('stores the key encrypted, the company identity, and a NULL base currency (SEK booking); echoes nothing', async () => {
    const userId = await seedUser()
    const connector = connectorAnswering(await fixture('companies.json'))
    registerConnector(connector)
    const apiKey = 'gnubok_sk_test_real_db_case'
    const row = await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey })

    // The connection landed, active, with the feed-from floor of a first connect.
    expect(row.provider).toBe('accounted')
    expect(row.status).toBe('connected')
    expect(row.is_active_destination).toBe(true)
    expect(row.feed_from).not.toBeNull()

    // Company identity from the live fixture; base currency NULL, never 'SEK'.
    const stored = await getConnection(userId, 'accounted')
    expect(stored).not.toBeNull()
    expect(stored!.external_company_id).toBe('732b80b7-d0f7-45b9-8083-571f8d28d001')
    expect(stored!.external_company_name).toBe('KOMMANDITBOLAGET TESTAREN 3')
    expect(stored!.base_currency).toBeNull()

    // The SEK booking: a null currency reads as the default ledger currency.
    expect(ledgerCurrencyOrDefault(stored!.base_currency)).toBe('SEK')

    // ENCRYPTED AT REST: the stored ciphertext is not the plaintext blob and
    // does not contain the key; only decryptSecrets with the env key gets it
    // back. (MUTATION TARGET: storing plaintext fails both.)
    expect(stored!.secrets_ciphertext).toBeTruthy()
    expect(String(stored!.secrets_ciphertext)).not.toContain(apiKey)
    const round = decryptSecrets<ApiKeySecrets>(stored!.secrets_ciphertext!, stored!.secrets_key_version)
    expect(round).toEqual({ apiKey })

    // NEVER ECHOED: everything the API layer could hand a user — the row as
    // serialized and the connection summary — carries no trace of the key.
    const summary = toConnectionSummary(stored!)
    expect(JSON.stringify(summary)).not.toContain(apiKey)
    expect(JSON.stringify(row)).not.toContain(apiKey)
  })

  it('a key that sees SEVERAL companies is refused (MultiCompanyKeyError) and stores NOTHING', async () => {
    const userId = await seedUser()
    const connector = connectorAnswering(await fixture('companies-multi.json'))
    registerConnector(connector)

    const err = await connectWithApiKey({
      provider: ACCOUNTED,
      connector,
      userId,
      apiKey: 'gnubok_sk_test_multi_case',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultiCompanyKeyError)
    expect((err as MultiCompanyKeyError).code).toBe('MULTI_COMPANY_KEY')

    // MUTATION TARGET: a connect that stored before validating would leave a
    // row behind — there must be NONE (nothing landed, nothing to clean up).
    expect(await getConnection(userId, 'accounted')).toBeNull()
  })

  it('a key the provider refuses (the live 401 envelope) becomes InvalidApiKeyError and stores NOTHING', async () => {
    const userId = await seedUser()
    const connector = connectorAnswering(await fixture('error-401.json'), 401)
    registerConnector(connector)

    const err = await connectWithApiKey({
      provider: ACCOUNTED,
      connector,
      userId,
      apiKey: 'gnubok_sk_test_refused_case',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidApiKeyError)
    expect((err as InvalidApiKeyError).code).toBe('INVALID_API_KEY')
    // The refusal names the HTTP verdict, not the key.
    expect((err as InvalidApiKeyError).message).not.toContain('gnubok_sk_test_refused_case')

    expect(await getConnection(userId, 'accounted')).toBeNull()
  })

  it('a reconnect to the same company keeps the row; the key is replaced under the same identity', async () => {
    const userId = await seedUser()
    const connector = connectorAnswering(await fixture('companies.json'))
    registerConnector(connector)
    const first = await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey: 'gnubok_sk_test_first' })
    expect(first.is_active_destination).toBe(true)

    // Reconnect with a NEW key: same company → no switch, row kept.
    const second = await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey: 'gnubok_sk_test_second' })
    expect(second.id).toBe(first.id)
    expect(second.external_company_id).toBe(first.external_company_id)
    expect(second.feed_from).toEqual(first.feed_from)
    const stored = await getConnection(userId, 'accounted')
    expect(decryptSecrets<ApiKeySecrets>(stored!.secrets_ciphertext!, stored!.secrets_key_version)).toEqual({
      apiKey: 'gnubok_sk_test_second',
    })
  })
})
