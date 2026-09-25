import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Accounted webhook module (#3019, epic #3016 slice 3) — registration,
 * teardown, envelope verification, redaction, per-type processing.
 *
 * What runs REAL here: `registerAccountedWebhooks` / `deleteAccountedWebhooks`
 * end to end over an in-process `fetch` double standing in for
 * `app.accounted.se` (three creates, the rollback, the orphan sweep), and the
 * whole `verifyAccountedSignature` / `redactAccountedWebhookObject` surface.
 * What is stubbed: the repository layer (`accounting-connections.ts` for the
 * callback-URL builder, `accounting-feed-syncs.ts` for the document-match
 * lookup) — database behaviour is proven on the real-Postgres harness
 * elsewhere (migration 092's own test). The secrets key is a real key in the
 * environment so the blob round-trip below exercises the real AES-GCM.
 *
 * The secrets in this file are fixture strings (`whsec_*`) — the redaction
 * test asserts they never reach an error message.
 */

const { connectionRepoMocks } = vi.hoisted(() => ({
  connectionRepoMocks: {
    webhookCallbackUrl: vi.fn((origin: string, token: string) => `${origin}/accounting/webhooks/accounted/${token}`),
  },
}))
vi.mock('../../../infra/repositories/accounting-connections.js', () => connectionRepoMocks)

const { syncRepoMocks } = vi.hoisted(() => ({
  syncRepoMocks: { confirmAccountedDocumentDelivery: vi.fn() },
}))
vi.mock('../../../infra/repositories/accounting-feed-syncs.js', () => syncRepoMocks)

const SECRETS_KEY_ENV = 'HAVEN_SECRETS_KEY'
const TEST_SECRETS_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' // 32 bytes, base64

beforeAll(() => {
  process.env[SECRETS_KEY_ENV] = TEST_SECRETS_KEY
})
afterAll(() => {
  delete process.env[SECRETS_KEY_ENV]
})

import {
  ACCOUNTED_WEBHOOK_EVENT_TYPES,
  ACCOUNTED_API_BASE,
} from '../accounted-client.js'
import {
  ACCOUNTED_WEBHOOK_STORED_PAYLOAD_MAX_BYTES,
  ACCOUNTED_WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  AccountedWebhookRegistrationError,
  deleteAccountedWebhooks,
  processAccountedWebhook,
  redactAccountedWebhookObject,
  registerAccountedWebhooks,
  verifyAccountedSignature,
} from '../accounted-webhooks.js'
import { decryptSecrets, encryptSecrets } from '../../../infra/secrets.js'

const ORIGIN = 'https://api.test'
const TOKEN = 'token-abc'
const CALLBACK_URL = `https://api.test/accounting/webhooks/accounted/${TOKEN}`

/** The HTTP double for the provider's webhook endpoints, with per-case switches. */
function registrationHarness(opts?: {
  /** Refuse THIS event type's create with 403 INSUFFICIENT_SCOPE. */
  failOn?: string
  /** Extra subscriptions the list sweep will see (orphans from lost responses). */
  orphans?: { id: string; webhook_url: string }[]
}) {
  const created: { id: string; event_type: string; secret: string; webhook_url: string }[] = []
  const deleted: string[] = []
  const posts: { url: string; body: Record<string, unknown> }[] = []
  let listed = 0
  const fetchImpl = vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST' && u.endsWith('/webhooks')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push({ url: u, body })
      if (opts?.failOn === body.event_type) {
        return new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_SCOPE' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      const id = `wh_${created.length + 1}`
      const secret = `whsec_${created.length + 1}`
      created.push({ id, event_type: String(body.event_type), secret, webhook_url: String(body.webhook_url) })
      return new Response(
        JSON.stringify({
          data: {
            id,
            event_type: body.event_type,
            webhook_url: body.webhook_url,
            name: body.name,
            active: true,
            api_version_pinned: '2026-05-12',
            secret,
            disabled_at: null,
            disabled_reason: null,
            created_at: '2026-09-20T00:00:00Z',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'DELETE' && u.includes('/webhooks/')) {
      const id = u.slice(u.indexOf('/webhooks/') + '/webhooks/'.length)
      deleted.push(id)
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && u.endsWith('/webhooks')) {
      listed += 1
      const live = created.filter((c) => !deleted.includes(c.id)).map((c) => ({
        id: c.id,
        name: `Haven — ${c.event_type}`,
        event_type: c.event_type,
        webhook_url: c.webhook_url,
        active: true,
        api_version_pinned: '2026-05-12',
        disabled_at: null,
        disabled_reason: null,
        created_at: '2026-09-20T00:00:00Z',
      }))
      return new Response(JSON.stringify({ data: { webhooks: [...live, ...(opts?.orphans ?? [])] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  })
  return { fetchImpl, created, deleted, posts, callsListed: () => listed }
}

describe('registerAccountedWebhooks (#3019 item 1) — three subscriptions, all-or-nothing', () => {
  it('creates the three event subscriptions on one callback URL and returns the three triples in order', async () => {
    const h = registrationHarness()
    const triples = await registerAccountedWebhooks({
      apiKey: 'gnubok_sk_test_k',
      companyId: 'comp_1',
      apiOrigin: ORIGIN,
      token: TOKEN,
      fetchImpl: h.fetchImpl,
    })
    expect(h.posts).toHaveLength(3)
    expect(h.posts.map((p) => p.body.event_type)).toEqual([...ACCOUNTED_WEBHOOK_EVENT_TYPES])
    // Every subscription points at the SAME capability URL built from the token.
    for (const p of h.posts) expect(p.body.webhook_url).toBe(CALLBACK_URL)
    expect(connectionRepoMocks.webhookCallbackUrl).toHaveBeenCalledWith(ORIGIN, TOKEN)
    expect(triples).toHaveLength(3)
    expect(triples.map((t) => t.eventType)).toEqual(['journal_entry.committed', 'period.locked', 'document.uploaded'])
    expect(triples.map((t) => t.subscriptionId)).toEqual(['wh_1', 'wh_2', 'wh_3'])
    expect(triples.map((t) => t.secret)).toEqual(['whsec_1', 'whsec_2', 'whsec_3'])
    expect(h.callsListed()).toBe(0) // no sweep on success
  })

  it('stores the three triples encrypted beside the API key and reads them back', async () => {
    // The storage CONTRACT: the secrets blob is one JSON object that still
    // carries `apiKey` and now carries `webhooks` — proven with the real
    // AES-GCM (the flow writes exactly this shape, api-key-flow.ts).
    const triples = [
      { subscriptionId: 'wh_1', eventType: 'journal_entry.committed' as const, secret: 'whsec_1' },
      { subscriptionId: 'wh_2', eventType: 'period.locked' as const, secret: 'whsec_2' },
      { subscriptionId: 'wh_3', eventType: 'document.uploaded' as const, secret: 'whsec_3' },
    ]
    const { ciphertext, keyVersion } = encryptSecrets({ apiKey: 'gnubok_sk_test_k', webhooks: triples } as unknown as Record<string, unknown>)
    expect(keyVersion).toBe(1)
    const round = decryptSecrets<{ apiKey: string; webhooks: typeof triples }>(ciphertext, keyVersion)
    expect(round.apiKey).toBe('gnubok_sk_test_k')
    expect(round.webhooks).toEqual(triples)
  })

  it('rolls back on a partial failure: deletes what was created, sweeps the list, and never leaks a secret in the error', async () => {
    const h = registrationHarness({ failOn: 'period.locked' })
    let err: unknown
    try {
      await registerAccountedWebhooks({
        apiKey: 'gnubok_sk_test_k',
        companyId: 'comp_1',
        apiOrigin: ORIGIN,
        token: TOKEN,
        fetchImpl: h.fetchImpl,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AccountedWebhookRegistrationError)
    expect((err as Error).message).toMatch(/period\.locked/)
    // All-or-nothing: only the first create landed at the provider, and the
    // rollback removed it.
    expect(h.created).toHaveLength(1)
    expect(h.deleted).toEqual(['wh_1'])
    // The orphan sweep ran (a lost create response leaves an unrecorded
    // subscription only reachable by its URL) and found nothing extra.
    expect(h.callsListed()).toBe(1)
    // The fixture secret never rides the error.
    expect((err as Error).message).not.toContain('whsec_')
  })

  it('the rollback sweep deletes an ORPHAN on our callback URL and leaves other URLs alone', async () => {
    const h = registrationHarness({
      failOn: 'document.uploaded',
      orphans: [
        { id: 'wh_orphan', webhook_url: CALLBACK_URL },
        { id: 'wh_other', webhook_url: 'https://api.test/accounting/webhooks/accounted/other-token' },
      ],
    })
    await expect(
      registerAccountedWebhooks({
        apiKey: 'gnubok_sk_test_k',
        companyId: 'comp_1',
        apiOrigin: ORIGIN,
        token: TOKEN,
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(AccountedWebhookRegistrationError)
    // The two successful creates are deleted by id, the orphan by URL; the
    // subscription on ANOTHER connection's URL stays.
    expect(h.deleted.sort()).toEqual(['wh_1', 'wh_2', 'wh_orphan'])
  })

  it('a create that answers no secret is a failure (the subscription could never be verified)', async () => {
    // The subscription EXISTS at the provider (the create answered 201) —
    // only its secret never arrived. The rollback must still remove it: the
    // sweep finds it by callback URL.
    const secretless = registrationHarness({ orphans: [{ id: 'wh_x', webhook_url: CALLBACK_URL }] })
    secretless.fetchImpl.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ data: { id: 'wh_x', event_type: 'journal_entry.committed' } }), { status: 201 }),
    )
    await expect(
      registerAccountedWebhooks({
        apiKey: 'gnubok_sk_test_k',
        companyId: 'comp_1',
        apiOrigin: ORIGIN,
        token: TOKEN,
        fetchImpl: secretless.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(AccountedWebhookRegistrationError)
    // The one create that landed was still swept away.
    expect(secretless.deleted).toEqual(['wh_x'])
  })
})

describe('deleteAccountedWebhooks (#3019 item 1) — disconnect deletes all three, best effort', () => {
  const triples = [
    { subscriptionId: 'wh_1', eventType: 'journal_entry.committed' as const, secret: 's1' },
    { subscriptionId: 'wh_2', eventType: 'period.locked' as const, secret: 's2' },
    { subscriptionId: 'wh_3', eventType: 'document.uploaded' as const, secret: 's3' },
  ]

  it('deletes every subscription and reports the counts', async () => {
    const h = registrationHarness()
    const r = await deleteAccountedWebhooks({ apiKey: 'k', companyId: 'comp_1', subscriptions: triples, fetchImpl: h.fetchImpl })
    expect(r).toEqual({ deleted: 3, failed: 0 })
    expect(h.deleted).toEqual(['wh_1', 'wh_2', 'wh_3'])
  })

  it('a provider outage on one delete never throws and never blocks the others', async () => {
    const h = registrationHarness()
    h.fetchImpl.mockImplementationOnce(async () => {
      throw new Error('network down')
    })
    const r = await deleteAccountedWebhooks({ apiKey: 'k', companyId: 'comp_1', subscriptions: triples, fetchImpl: h.fetchImpl })
    expect(r).toEqual({ deleted: 2, failed: 1 })
  })

  it('a 404 on delete counts as removed (the goal state is "no subscription")', async () => {
    const h = registrationHarness()
    h.fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }))
    const r = await deleteAccountedWebhooks({ apiKey: 'k', companyId: 'comp_1', subscriptions: triples, fetchImpl: h.fetchImpl })
    expect(r).toEqual({ deleted: 3, failed: 0 })
  })
})

describe('verifyAccountedSignature (#3019 item 3) — HMAC over the raw bytes', () => {
  const SECRET = 'whsec_matrix'
  const RAW = '{"id":"evt_1","type":"journal_entry.committed"}'
  const nowMs = 1_789_900_000_000

  function sign(secret: string, raw: string, tSeconds: number): string {
    const v1 = createHmac('sha256', secret).update(`${tSeconds}.${raw}`).digest('hex')
    return `t=${tSeconds},v1=${v1}`
  }

  it('accepts a fresh, correctly-signed delivery', () => {
    const v = verifyAccountedSignature({
      rawBody: Buffer.from(RAW, 'utf8'),
      header: sign(SECRET, RAW, Math.floor(nowMs / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(v).toEqual({ ok: true })
  })

  it('refuses a wrong secret (bad_signature) and a tampered body (bad_signature)', () => {
    const badSecret = verifyAccountedSignature({
      rawBody: Buffer.from(RAW, 'utf8'),
      header: sign('whsec_other', RAW, Math.floor(nowMs / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(badSecret).toEqual({ ok: false, reason: 'bad_signature' })
    const tampered = verifyAccountedSignature({
      rawBody: Buffer.from(RAW.replace('evt_1', 'evt_2'), 'utf8'),
      header: sign(SECRET, RAW, Math.floor(nowMs / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(tampered).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a timestamp older than the 5-minute window (stale_timestamp) — 6 minutes is stale', () => {
    const stale = verifyAccountedSignature({
      rawBody: Buffer.from(RAW, 'utf8'),
      header: sign(SECRET, RAW, Math.floor((nowMs - 6 * 60_000) / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(stale).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('the window boundary: a signature exactly at the tolerance still verifies', () => {
    const edge = verifyAccountedSignature({
      rawBody: Buffer.from(RAW, 'utf8'),
      header: sign(SECRET, RAW, Math.floor((nowMs - ACCOUNTED_WEBHOOK_TIMESTAMP_TOLERANCE_MS) / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(edge).toEqual({ ok: true })
    expect(ACCOUNTED_WEBHOOK_TIMESTAMP_TOLERANCE_MS).toBe(5 * 60_000)
  })

  it('malformed headers: missing, garbage, short v1, non-numeric t', () => {
    const cases: (string | undefined)[] = [
      undefined,
      'v1=deadbeef',
      `t=${Math.floor(nowMs / 1000)}`,
      `t=${Math.floor(nowMs / 1000)},v1=not-hex-zzzz`,
      `t=notanumber,v1=${'a'.repeat(64)}`,
      `t=${Math.floor(nowMs / 1000)},v1=${'a'.repeat(32)}`,
    ]
    for (const header of cases) {
      const v = verifyAccountedSignature({ rawBody: Buffer.from(RAW, 'utf8'), header, secret: SECRET, nowMs })
      expect(v).toEqual({ ok: false, reason: 'malformed_header' })
    }
  })

  it('the signature covers the SENT bytes, not the parsed JSON: same object, different whitespace → bad_signature', () => {
    const sent = '{"a":1}'
    const other = '{"a": 1}'
    const v = verifyAccountedSignature({
      rawBody: Buffer.from(other, 'utf8'),
      header: sign(SECRET, sent, Math.floor(nowMs / 1000)),
      secret: SECRET,
      nowMs,
    })
    expect(v).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('redactAccountedWebhookObject (#3019 item 4) — the allowlist principle', () => {
  it('drops the sensitive keys and keeps the bookkeeping ones', () => {
    const out = redactAccountedWebhookObject({
      id: 'je_1',
      voucher_number: 'A1',
      notes: 'internal note',
      description: 'a description',
      metadata: { anything: true },
      attachments: [{ url: 'https://x' }],
      download_url: 'https://x',
      amount: '100.00',
    })
    expect(out).toEqual({ id: 'je_1', voucher_number: 'A1', amount: '100.00' })
  })

  it('returns null when every key was redacted or the object is over the size cap', () => {
    expect(redactAccountedWebhookObject({ notes: 'only' })).toBeNull()
    const big = redactAccountedWebhookObject({ id: 'x', blob: 'y'.repeat(ACCOUNTED_WEBHOOK_STORED_PAYLOAD_MAX_BYTES) })
    expect(big).toBeNull()
  })
})

describe('processAccountedWebhook (#3019 item 4) — per-type counting', () => {
  beforeEach(() => {
    syncRepoMocks.confirmAccountedDocumentDelivery.mockReset()
  })

  it('journal_entry.committed counts as its own type (the payload is stored by the route)', async () => {
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'journal_entry.committed', object: { id: 'je_1' } })).resolves.toBe(
      'processed_journal_entry_committed',
    )
  })

  it('period.locked counts only', async () => {
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'period.locked', object: null })).resolves.toBe('processed_period_locked')
  })

  it('document.uploaded matching a pushed sync row confirms the delivery', async () => {
    syncRepoMocks.confirmAccountedDocumentDelivery.mockResolvedValue(true)
    await expect(
      processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { document_id: 'doc_1' } }),
    ).resolves.toBe('confirmed_document_uploaded')
    expect(syncRepoMocks.confirmAccountedDocumentDelivery).toHaveBeenCalledWith('user_1', 'doc_1')
  })

  it('document.uploaded with no matching sync row (or a read failure) falls back to the plain processed count', async () => {
    syncRepoMocks.confirmAccountedDocumentDelivery.mockResolvedValue(false)
    await expect(
      processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { document_id: 'doc_2' } }),
    ).resolves.toBe('processed_document_uploaded')
    syncRepoMocks.confirmAccountedDocumentDelivery.mockRejectedValue(new Error('db down'))
    await expect(
      processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { document_id: 'doc_3' } }),
    ).resolves.toBe('processed_document_uploaded')
  })

  it('the document id is found wherever the payload names it — or not at all', async () => {
    syncRepoMocks.confirmAccountedDocumentDelivery.mockResolvedValue(true)
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { id: 'doc_a' } })).resolves.toBe(
      'confirmed_document_uploaded',
    )
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { document: { id: 'doc_b' } } })).resolves.toBe(
      'confirmed_document_uploaded',
    )
    syncRepoMocks.confirmAccountedDocumentDelivery.mockClear()
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: { other: 'x' } })).resolves.toBe(
      'processed_document_uploaded',
    )
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'document.uploaded', object: null })).resolves.toBe(
      'processed_document_uploaded',
    )
    expect(syncRepoMocks.confirmAccountedDocumentDelivery).not.toHaveBeenCalled()
  })

  it('unknown types — including the provider webhook.test probe — count as unknown', async () => {
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'webhook.test', object: null })).resolves.toBe('unknown_type')
    await expect(processAccountedWebhook({ userId: 'user_1', eventType: 'something.future', object: null })).resolves.toBe('unknown_type')
    expect(syncRepoMocks.confirmAccountedDocumentDelivery).not.toHaveBeenCalled()
  })
})
