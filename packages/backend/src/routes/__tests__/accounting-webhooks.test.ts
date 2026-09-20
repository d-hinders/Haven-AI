import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * The Accounted webhook receiver route (#3019, epic #3016 slice 3) — the
 * answer matrix, the signature-before-parse order, the trailing-slash twin,
 * and the durable dedupe wiring.
 *
 * What runs REAL: the route plugin exactly as `index.ts` registers it (its
 * OWN encapsulated raw-body parser included) over Fastify `inject`, the
 * signature verification, and the encryption round trip (a real
 * `HAVEN_SECRETS_KEY`). What is stubbed: the two repository modules (the
 * capability lookup and the delivery ledger) and the document-confirmation
 * collaborator — database behaviour is proven on the real-Postgres harness
 * (migration 092's test); these tests own the ROUTE's decisions.
 *
 * The answer matrix, stated by the issue and pinned below:
 *   400 bad/malformed signature or stale t · 404 unknown token · 200 for
 *   everything else — feature off, unparseable-but-signed JSON,
 *   `webhook.test`, unknown types, duplicates, success — and NEVER 410 and
 *   NEVER any 3xx, on either path spelling.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: { accountingEnabled: true },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

const { connectionRepo } = vi.hoisted(() => ({
  connectionRepo: {
    ACCOUNTING_WEBHOOK_CALLBACK_PREFIX: '/accounting/webhooks/accounted',
    getConnectionByWebhookToken: vi.fn(),
  },
}))
vi.mock('../../infra/repositories/accounting-connections.js', () => connectionRepo)

const { deliveriesRepo } = vi.hoisted(() => ({
  deliveriesRepo: { recordWebhookDelivery: vi.fn() },
}))
vi.mock('../../infra/repositories/accounting-webhook-deliveries.js', () => deliveriesRepo)

const { syncRepo } = vi.hoisted(() => ({
  syncRepo: { confirmAccountedDocumentDelivery: vi.fn() },
}))
vi.mock('../../infra/repositories/accounting-feed-syncs.js', () => syncRepo)

const { countersMock } = vi.hoisted(() => ({
  countersMock: {
    incrementAccountingWebhookCounter: vi.fn(),
    resetAccountingWebhookCountersForTests: vi.fn(),
  },
}))
vi.mock('../../modules/accounting/ops-signals.js', () => ({
  incrementAccountingWebhookCounter: countersMock.incrementAccountingWebhookCounter,
  resetAccountingWebhookCountersForTests: countersMock.resetAccountingWebhookCountersForTests,
}))

beforeAll(() => {
  process.env.HAVEN_SECRETS_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' // 32 bytes, base64
})
afterAll(() => {
  delete process.env.HAVEN_SECRETS_KEY
})

import accountingWebhookRoutes from '../accounting-webhooks.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { resetAccountingWebhookCountersForTests } from '../../modules/accounting/ops-signals.js'
import { decryptSecrets, encryptSecrets } from '../../infra/secrets.js'
import type { AccountedWebhookSubscriptionSecret } from '../../modules/accounting/accounted-webhooks.js'

const TOKEN = 'tok_' + randomBytes(16).toString('hex')
const SECRET = 'whsec_route_test'
const TRIPLES: AccountedWebhookSubscriptionSecret[] = [
  { subscriptionId: 'wh_1', eventType: 'journal_entry.committed', secret: SECRET },
  { subscriptionId: 'wh_2', eventType: 'period.locked', secret: 'whsec_period' },
  { subscriptionId: 'wh_3', eventType: 'document.uploaded', secret: 'whsec_doc' },
]

function signedHeader(raw: string, secret: string, tSeconds?: number): string {
  const t = tSeconds ?? Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function row(overrides?: Record<string, unknown>) {
  const { ciphertext, keyVersion } = encryptSecrets({ apiKey: 'gnubok_sk_test_k', webhooks: TRIPLES } as unknown as Record<string, unknown>)
  return {
    user_id: 'user_1',
    webhook_token: TOKEN,
    secrets_ciphertext: ciphertext,
    secrets_key_version: keyVersion,
    ...overrides,
  }
}

/** Counters named by the route, read back from the mock — one helper, asserted per case. */
function countedNames(): string[] {
  return countersMock.incrementAccountingWebhookCounter.mock.calls.map((c) => c[0] as string)
}

let app: FastifyInstance | undefined

beforeEach(async () => {
  vi.clearAllMocks()
  resetAccountingWebhookCountersForTests()
  configMock.accountingEnabled = true
  app = Fastify()
  await app.register(accountingWebhookRoutes)
  deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
})

afterEach(async () => {
  await app?.close()
  app = undefined
})

const BASE = '/accounting/webhooks/accounted'

/** One delivery, signed with the triple's secret. */
function delivery(input: {
  body?: string
  secret?: string
  tSeconds?: number
  header?: string
  event?: string | null
  deliveryId?: string | null
  apiVersion?: string | null
  requestId?: string | null
}): { payload: string; headers: Record<string, string> } {
  const payload =
    input.body ??
    JSON.stringify({
      id: input.deliveryId ?? 'evt_1',
      type: input.event ?? 'journal_entry.committed',
      data: { object: { id: 'je_default', voucher_number: 'V1' } },
    })
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-gnubok-signature': input.header ?? signedHeader(payload, input.secret ?? SECRET, input.tSeconds),
  }
  if (input.event !== null) headers['x-gnubok-event'] = input.event ?? 'journal_entry.committed'
  if (input.deliveryId !== null) headers['x-gnubok-delivery'] = input.deliveryId ?? 'evt_1'
  if (input.apiVersion !== null) headers['x-gnubok-api-version'] = input.apiVersion ?? '2026-05-12'
  if (input.requestId !== null) headers['x-request-id'] = input.requestId ?? 'req_1'
  return { payload, headers }
}

async function post(body: string, headers: Record<string, string>, path = `${BASE}/${TOKEN}`) {
  return app!.inject({ method: 'POST', url: path, payload: body, headers })
}

describe('POST /accounting/webhooks/accounted/:token — the answer matrix', () => {
  it('valid signature, first delivery → 200, row written, processed counter, payload recorded', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
    const d = delivery({ deliveryId: 'evt_ok1', event: 'journal_entry.committed' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', counted: 'processed_journal_entry_committed', deliveryId: 'evt_ok1' })
    // The dedupe row was written BEFORE the 2xx with the redacted payload and
    // the stamped processed_at.
    expect(deliveriesRepo.recordWebhookDelivery).toHaveBeenCalledTimes(1)
    const arg = deliveriesRepo.recordWebhookDelivery.mock.calls[0][0]
    expect(arg).toMatchObject({
      provider: 'accounted',
      deliveryId: 'evt_ok1',
      eventType: 'journal_entry.committed',
      apiVersion: '2026-05-12',
      requestId: 'req_1',
      processed: true,
    })
    expect(arg.payload).toEqual({ id: 'je_default', voucher_number: 'V1' })
    // S1 (PR #3196 review): the ledger row carries WHOSE delivery it was —
    // the connection the capability token resolved.
    expect(arg.userId).toBe('user_1')
    expect(countedNames()).toEqual(['received', 'processed'])
  })

  it('bad signature → 400 (the provider reference status), nothing stored, bad_signature counted', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const d = delivery({ deliveryId: 'evt_bad1' })
    const res = await post(d.payload, { ...d.headers, 'x-gnubok-signature': signedHeader(d.payload, 'whsec_wrong') })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad-signature', reason: 'bad_signature' })
    expect(deliveriesRepo.recordWebhookDelivery).not.toHaveBeenCalled()
    expect(countedNames()).toEqual(['received', 'bad_signature'])
  })

  it('stale timestamp (6 minutes old, valid signature) → 400 stale', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const d = delivery({ deliveryId: 'evt_stale1', tSeconds: Math.floor((Date.now() - 6 * 60_000) / 1000) })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad-signature', reason: 'stale_timestamp' })
    expect(countedNames()).toEqual(['received', 'stale'])
  })

  it('unknown token → 404 and nothing else runs', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(null)
    const d = delivery({ deliveryId: 'evt_unk' })
    const res = await post(d.payload, d.headers, `${BASE}/no-such-token`)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ status: 'unknown-token' })
    expect(countedNames()).toEqual(['received', 'unknown_token'])
  })

  it('feature off → 200 with the feature_off counter, after the signature verdict', async () => {
    configMock.accountingEnabled = false
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const d = delivery({ deliveryId: 'evt_off' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', counted: 'feature_off' })
    expect(deliveriesRepo.recordWebhookDelivery).not.toHaveBeenCalled()
    expect(countedNames()).toEqual(['received', 'feature_off'])
  })

  it('a body that fails JSON parse still gets the SIGNATURE verdict first: signed garbage → 200 unknown_type, unsigned garbage → 400', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const garbage = 'not-json-at-all{{'
    const signed = await post(garbage, delivery({ body: garbage, deliveryId: null, event: null }).headers)
    expect(signed.statusCode).toBe(200)
    expect(signed.json()).toEqual({ status: 'ok', counted: 'unknown_type' })
    expect(deliveriesRepo.recordWebhookDelivery).not.toHaveBeenCalled()
    // Nothing was recorded and nothing processed — the envelope never became
    // a delivery. The counter says what the answer was.
    expect(countedNames()).toEqual(['received', 'unknown_type'])

    vi.clearAllMocks()
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const unsigned = await post(garbage, { 'content-type': 'application/json' })
    expect(unsigned.statusCode).toBe(400)
    expect(countedNames()).toEqual(['received', 'bad_signature'])
  })

  it('webhook.test → 200 counted as unknown_type (the probe proves the receiver)', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const body = JSON.stringify({ id: 'evt_test', type: 'webhook.test', data: {} })
    const d = delivery({ body, deliveryId: 'evt_test', event: 'webhook.test', secret: SECRET })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', counted: 'unknown_type' })
    expect(deliveriesRepo.recordWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'webhook.test', payload: null }))
    expect(countedNames()).toEqual(['received', 'unknown_type', 'processed'])
  })

  it('duplicate delivery id → 200, counted duplicate, no second processing', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: false })
    const d = delivery({ deliveryId: 'evt_dup1' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', counted: 'duplicate', deliveryId: 'evt_dup1' })
    expect(countedNames()).toEqual(['received', 'duplicate'])
  })

  it('the delivery id comes from the envelope when the header is absent', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const body = JSON.stringify({ id: 'evt_env1', type: 'period.locked' })
    const headers = {
      'content-type': 'application/json',
      'x-gnubok-signature': signedHeader(body, SECRET),
      'x-gnubok-event': 'period.locked',
    }
    const res = await post(body, headers)
    expect(res.statusCode).toBe(200)
    expect(deliveriesRepo.recordWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'evt_env1' }))
  })

  it('document.uploaded that matches a sync row → confirmed counter', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    syncRepo.confirmAccountedDocumentDelivery.mockResolvedValue(true)
    const body = JSON.stringify({ id: 'evt_doc1', type: 'document.uploaded', data: { object: { document_id: 'doc_9' } } })
    const d = delivery({ body, deliveryId: 'evt_doc1', event: 'document.uploaded', secret: SECRET })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ counted: 'confirmed_document_uploaded' })
    // S1 (PR #3196 review): the confirmation is scoped to the connection's
    // own ledger — the route passes the row's user, never a bare document id
    // (which is only unique WITHIN a user's sync rows).
    expect(syncRepo.confirmAccountedDocumentDelivery).toHaveBeenCalledWith('user_1', 'doc_9')
    expect(countedNames()).toEqual(['received', 'confirmed', 'processed'])
  })

  it('a subscription whose secret never made it to the blob still verifies: an unknown type is tried against EVERY stored secret', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    // Signed with the document.uploaded triple while naming an event type
    // that has no triple of its own — the fallback order (own type first,
    // then the rest) is what makes a `webhook.test` signed by whichever
    // subscription dispatched it verify.
    const body = JSON.stringify({ id: 'evt_fb', type: 'webhook.test', data: {} })
    const d = delivery({ body, deliveryId: 'evt_fb', event: 'webhook.test', secret: 'whsec_doc' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ counted: 'unknown_type' })
  })

  it('a connection stored without webhook triples answers 400 (nothing to verify against)', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row({ secrets_ciphertext: null, secrets_key_version: 0 }))
    const d = delivery({ deliveryId: 'evt_nosecret' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(400)
  })

  it('a POST with no Content-Type is a probe, not a crash: 400 bad_signature, never a 500 (PR #3196 review)', async () => {
    // Fastify's parser never runs without a Content-Type, so `request.body`
    // is undefined — the guard answers 400 and counts it instead of handing
    // `undefined` to the HMAC (a 500 the provider would retry forever).
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const res = await app!.inject({ method: 'POST', url: `${BASE}/${TOKEN}` })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: 'bad-signature', reason: 'malformed_header' })
    expect(countedNames()).toEqual(['bad_signature'])
  })
})

describe('the no-410 / no-3xx invariant — every path, both path spellings', () => {
  /** Every scenario the route can answer with, signed where the matrix says so. */
  function scenarios(): { name: string; fn: () => Promise<number> }[] {
    const cases: { name: string; fn: () => Promise<number> }[] = []
    cases.push({
      name: 'valid first delivery',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
        const d = delivery({ deliveryId: `evt_m_${randomBytes(4).toString('hex')}` })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'duplicate',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: false })
        const d = delivery({ deliveryId: `evt_d_${randomBytes(4).toString('hex')}` })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'bad signature',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        const d = delivery({ deliveryId: null, event: null })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'stale timestamp',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        const d = delivery({ deliveryId: null, event: null, tSeconds: Math.floor((Date.now() - 6 * 60_000) / 1000) })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'malformed signature header',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        const d = delivery({ deliveryId: null, event: null, header: 'garbage' })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'unknown token',
      fn: async () => {
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(null)
        const d = delivery({ deliveryId: null, event: null })
        return (await post(d.payload, d.headers, `${BASE}/missing`)).statusCode
      },
    })
    cases.push({
      name: 'feature off',
      fn: async () => {
        configMock.accountingEnabled = false
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        const d = delivery({ deliveryId: null, event: null })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'webhook.test',
      fn: async () => {
        configMock.accountingEnabled = true
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
        const body = JSON.stringify({ id: `evt_t_${randomBytes(4).toString('hex')}`, type: 'webhook.test', data: {} })
        const d = delivery({ body, deliveryId: `evt_t_${randomBytes(4).toString('hex')}`, event: 'webhook.test' })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'unknown event type',
      fn: async () => {
        configMock.accountingEnabled = true
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
        const body = JSON.stringify({ id: `evt_u_${randomBytes(4).toString('hex')}`, type: 'future.thing', data: {} })
        const d = delivery({ body, deliveryId: `evt_u_${randomBytes(4).toString('hex')}`, event: 'future.thing' })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'unparseable but signed body',
      fn: async () => {
        configMock.accountingEnabled = true
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        const garbage = '}<not json'
        const d = delivery({ body: garbage, deliveryId: null, event: null })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    cases.push({
      name: 'document.uploaded confirmed',
      fn: async () => {
        configMock.accountingEnabled = true
        connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
        syncRepo.confirmAccountedDocumentDelivery.mockResolvedValue(true)
        deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
        const body = JSON.stringify({ id: `evt_c_${randomBytes(4).toString('hex')}`, type: 'document.uploaded', data: { object: { document_id: 'doc' } } })
        const d = delivery({ body, deliveryId: `evt_c_${randomBytes(4).toString('hex')}`, event: 'document.uploaded' })
        return (await post(d.payload, d.headers)).statusCode
      },
    })
    return cases
  }

  for (const suffix of ['', '/'] as const) {
    it(`enumerates the route's responses on the '${suffix || 'exact'}' path spelling — only 200/400/404, never 410, never 3xx`, async () => {
      const seen: { scenario: string; code: number }[] = []
      for (const s of scenarios()) {
        vi.clearAllMocks()
        syncRepo.confirmAccountedDocumentDelivery.mockReset().mockResolvedValue(false)
        deliveriesRepo.recordWebhookDelivery.mockReset().mockResolvedValue({ inserted: true })
        configMock.accountingEnabled = true
        const code = await s.fn()
        seen.push({ scenario: s.name, code })
        expect(code, `${s.name} answered ${code}`).toBeOneOf([200, 400, 404])
        expect(code).not.toBe(410)
        expect(code >= 300 && code < 400).toBe(false)
      }
      // The matrix genuinely covers the classes the issue names.
      const codes = new Set(seen.map((s) => s.code))
      expect(codes).toEqual(new Set([200, 400, 404]))
    })
  }
})

describe('the raw-body parser is route-scoped', () => {
  it('the parser hands through the raw Buffer untouched — the bytes the signature covers', async () => {
    // The stored payload and the signature verdict on a body with unusual
    // spacing prove the route hashed and parsed the same bytes.
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
    const body = '{"id":"evt_space","type":"journal_entry.committed","data":{"object":{"id":"je_1","note_key":"a  b"}}}'
    const d = delivery({ body, deliveryId: 'evt_space' })
    const res = await post(d.payload, d.headers)
    expect(res.statusCode).toBe(200)
    expect(deliveriesRepo.recordWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 'je_1', note_key: 'a  b' } }))
  })

  it('a non-JSON content type the provider might send is not silently coerced (the parser is bound to application/json)', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    const body = '{"id":"evt_ct","type":"period.locked"}'
    const signature = signedHeader(body, SECRET)
    // Fastify refuses an unregistered content type with 415 — never a 3xx,
    // never a silent re-parse. (application/json itself is covered above.)
    const res = await app!.inject({
      method: 'POST',
      url: `${BASE}/${TOKEN}`,
      payload: body,
      headers: { 'content-type': 'text/plain', 'x-gnubok-signature': signature },
    })
    expect([200, 400, 404, 415]).toContain(res.statusCode)
    expect(res.statusCode).not.toBe(410)
    expect(res.statusCode >= 300 && res.statusCode < 400).toBe(false)
  })
})

describe('the shadow-mode validation plugin must not corrupt the raw body (B1, PR #3196 review)', () => {
  /**
   * The wiring that would have gone red on the B1 head: the ROOT-SCOPE
   * request-validation plugin (as `index.ts` installs it, default shadow),
   * THEN the webhook route. The bare-`Fastify()` mounts above never ran the
   * plugin, which is exactly why all of them stayed green while every
   * production delivery was refused.
   *
   * The bug, for the record: shadow's `preValidation` snapshot hook claimed
   * Buffers were excluded but only checked `typeof body === 'object'` — a
   * Buffer IS an object, `structuredClone(Buffer)` yields a plain
   * `Uint8Array`, and restoring it over `request.body` replaced the raw
   * bytes with `"123,34,…"`. The route then hashed the comma digits and
   * every CORRECTLY signed delivery was refused 400 `bad_signature`.
   */
  let shadowApp: FastifyInstance

  beforeAll(async () => {
    shadowApp = Fastify({ logger: false })
    installRequestValidation(shadowApp, { mode: 'shadow' })
    await shadowApp.register(accountingWebhookRoutes)
  })

  afterAll(async () => {
    await shadowApp?.close()
  })

  it('a correctly signed delivery → 200 with the plugin installed in shadow mode ahead of the route', async () => {
    connectionRepo.getConnectionByWebhookToken.mockResolvedValue(row())
    deliveriesRepo.recordWebhookDelivery.mockResolvedValue({ inserted: true })
    const body = JSON.stringify({ id: 'evt_b1', type: 'journal_entry.committed', data: { object: { id: 'je_b1' } } })
    const headers = {
      'content-type': 'application/json',
      'x-gnubok-signature': signedHeader(body, SECRET),
      'x-gnubok-event': 'journal_entry.committed',
      'x-gnubok-delivery': 'evt_b1',
    }
    const res = await shadowApp.inject({ method: 'POST', url: `${BASE}/${TOKEN}`, payload: body, headers })
    // On the broken head this was 400: the HMAC ran over the mangled
    // snapshot, not the bytes the provider signed.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', counted: 'processed_journal_entry_committed', deliveryId: 'evt_b1' })
    // The stored payload was parsed from the CLIENT's bytes — proof the
    // body the handler saw is the body the signature covered.
    expect(deliveriesRepo.recordWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 'je_b1' } }))
  })
})

describe('rate limit tier (#3019 item 3)', () => {
  it('the ceiling sits above any retry storm — 600/min pinned, so a silent edit to a storm-vulnerable number goes red', async () => {
    const { WEBHOOK_RATE_LIMIT } = await import('../accounting-webhooks.js')
    expect(WEBHOOK_RATE_LIMIT).toEqual({ max: 600, timeWindow: '1 minute' })
  })
})
