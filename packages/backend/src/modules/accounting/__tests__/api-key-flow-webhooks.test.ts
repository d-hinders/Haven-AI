import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `connectWithApiKey`'s webhook half (#3019, epic #3016 slice 3).
 *
 * The flow's own ordering contract, pinned here: the connection row is stored
 * FIRST (the callback URL must resolve before any subscription can deliver),
 * the capability token is set BEFORE the registration runs, the registration
 * runs with the PLAINTEXT secrets and the token, the stored secrets blob is
 * RE-ENCRYPTED once carrying the three triples, and a registration failure
 * leaves the row connected but flagged `needs_attention` with the reason.
 *
 * What is stubbed: the repository layer and the company-info step — the
 * registration function itself is a spy HERE (its provider-HTTP contract is
 * `accounted-webhooks.test.ts`'s subject; the real one is exercised through
 * `connections.ts`'s adapter below). Secrets use a real key: the re-encrypted
 * blob is decrypted to prove what landed in it.
 */

const { repoMocks } = vi.hoisted(() => ({
  repoMocks: {
    getConnection: vi.fn(),
    upsertConnection: vi.fn(),
    stampFeedFromIfUnset: vi.fn(),
    setWebhookToken: vi.fn(),
    updateSecrets: vi.fn(),
    setStatus: vi.fn(),
    // ops-signals re-exports this list's length in its own module state; a
    // mock-only value of the same shape suffices here.
    NEEDS_ATTENTION_STATUSES: ['needs_reauthorisation', 'scope_missing', 'revoked_at_provider', 'needs_attention'],
    newWebhookToken: vi.fn(() => 'tok_' + 'x'.repeat(43)),
  },
}))
vi.mock('../../../infra/repositories/accounting-connections.js', () => repoMocks)

const { companyInfoMocks } = vi.hoisted(() => ({
  companyInfoMocks: { applyCompanyInfo: vi.fn() },
}))
vi.mock('../company-info.js', () => companyInfoMocks)

const { registerSpy, deleteSpy, verifySpy, flagSpy, emitSpy } = vi.hoisted(() => ({
  registerSpy: vi.fn(),
  deleteSpy: vi.fn(),
  verifySpy: vi.fn(),
  flagSpy: vi.fn(),
  emitSpy: vi.fn(),
}))
vi.mock('../ops-signals.js', () => ({
  flagConnectionStatus: flagSpy,
  emitOpsEvent: emitSpy,
  ACCOUNTING_EVENT: {
    webhookTeardownFailed: 'accounting.webhook.teardown_failed',
    webhookVerificationFailed: 'accounting.webhook.verification_failed',
  },
}))
vi.mock('../accounted-webhooks.js', () => ({
  AccountedWebhookRegistrationError: class extends Error {
    constructor(message: string) {
      super(message)
    }
  },
  registerAccountedWebhooks: registerSpy,
  // S3 (PR #3196 review) imports the teardown for the reconnect path; its
  // provider-HTTP contract is `accounted-webhooks.test.ts`'s subject.
  deleteAccountedWebhooks: deleteSpy,
}))

beforeAll(() => {
  process.env.HAVEN_SECRETS_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' // 32 bytes, base64
  // S5 (PR #3196 review): `webhookApiOrigin()` no longer falls back to
  // localhost — without a stated origin the flow flags the row instead of
  // registering. These tests exercise the REGISTRATION half, so the origin
  // is stated for the whole file; the no-origin behaviour has its own case
  // below.
  process.env.HAVEN_API_URL = 'https://api.example.test'
})
afterAll(() => {
  delete process.env.HAVEN_SECRETS_KEY
  delete process.env.HAVEN_API_URL
})

import { connectWithApiKey } from '../api-key-flow.js'
import { AccountedWebhookRegistrationError } from '../accounted-webhooks.js'
import { decryptSecrets, encryptSecrets } from '../../../infra/secrets.js'
import type { AccountingConnectionRow } from '../../../infra/repositories/accounting-connections.js'
import type { AccountingProvider, ProviderCompanyInfo } from '../provider.js'
import { ProviderError } from '../provider.js'
import type { AccountingConnector } from '../connector.js'
import type { AccountedWebhookSubscriptionSecret } from '../accounted-webhooks.js'

const PROVIDER = {
  id: 'accounted',
  displayName: 'Accounted',
  authKind: 'api_key',
  capabilities: {},
  availability: { kind: 'live' },
  requiredScopes: [],
} as unknown as AccountingProvider

const CONNECTOR = {
  getCompanyInfo: vi.fn(async () => ({
    externalCompanyId: 'comp_1',
    name: 'Testbolag AB',
    baseCurrency: null,
    scopeRefused: false,
  })),
} as unknown as AccountingConnector

const TRIPLES: AccountedWebhookSubscriptionSecret[] = [
  { subscriptionId: 'wh_1', eventType: 'journal_entry.committed', secret: 'whsec_1' },
  { subscriptionId: 'wh_2', eventType: 'period.locked', secret: 'whsec_2' },
  { subscriptionId: 'wh_3', eventType: 'document.uploaded', secret: 'whsec_3' },
]

function row(overrides?: Partial<AccountingConnectionRow>): AccountingConnectionRow {
  return {
    id: 'row_1',
    user_id: 'user_1',
    provider: 'accounted',
    auth_kind: 'api_key',
    secrets_ciphertext: Buffer.from('seed'),
    secrets_key_version: 1,
    external_company_id: 'comp_1',
    external_company_name: 'Testbolag AB',
    base_currency: null,
    status: 'connected',
    status_reason: null,
    granted_scope: null,
    token_expires_at: null,
    is_active_destination: true,
    feed_from: null,
    settings: {},
    last_push_at: null,
    last_error: null,
    created_at: new Date('2026-09-20T00:00:00Z'),
    updated_at: new Date('2026-09-20T00:00:00Z'),
    webhook_token: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  repoMocks.getConnection.mockResolvedValue(null)
  repoMocks.upsertConnection.mockImplementation(async (_userId: string, input: Record<string, unknown>) =>
    row({ secrets_ciphertext: input.secretsCiphertext as Buffer, secrets_key_version: input.secretsKeyVersion as number }),
  )
  repoMocks.stampFeedFromIfUnset.mockResolvedValue(null)
  repoMocks.setWebhookToken.mockResolvedValue(row())
  companyInfoMocks.applyCompanyInfo.mockImplementation(async ({ saved }: { saved: AccountingConnectionRow }) => saved)
  registerSpy.mockResolvedValue(TRIPLES)
  verifySpy.mockResolvedValue({ verificationStatus: 'verified' })
  // The default company read (tests that need otherwise override it and the
  // next test's beforeEach restores this).
  ;(CONNECTOR.getCompanyInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
    externalCompanyId: 'comp_1',
    name: 'Testbolag AB',
    baseCurrency: null,
    scopeRefused: false,
  })
})

describe('connectWithApiKey #3019 — the webhook half of connect', () => {
  it('stores the row first, sets the token, registers with the plaintext key + token, then re-encrypts the secrets carrying the triples', async () => {
    const calls: string[] = []
    repoMocks.upsertConnection.mockImplementation(async () => {
      calls.push('upsert')
      return row()
    })
    repoMocks.setWebhookToken.mockImplementation(async () => {
      calls.push('token')
      return row()
    })
    registerSpy.mockImplementation(async () => {
      calls.push('register')
      return TRIPLES
    })
    repoMocks.updateSecrets.mockImplementation(async () => {
      calls.push('re-encrypt')
    })

    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })

    // The order the issue demands: row → token → registration → secrets.
    expect(calls).toEqual(['upsert', 'token', 'register', 're-encrypt'])
    // The registration got the PLAINTEXT key, the same token that was set,
    // and the public origin the callback URL is built on (S5).
    expect(registerSpy).toHaveBeenCalledTimes(1)
    const reg = registerSpy.mock.calls[0][0] as { secrets: { apiKey: string }; companyId: string; token: string; apiOrigin: string }
    expect(reg.secrets.apiKey).toBe('gnubok_sk_test_k')
    expect(reg.companyId).toBe('comp_1')
    expect(reg.token).toBe(repoMocks.newWebhookToken())
    expect(reg.apiOrigin).toBe('https://api.example.test')
    expect(repoMocks.setWebhookToken).toHaveBeenCalledWith('user_1', 'accounted', reg.token)

    // The final secrets blob carries BOTH the key and the three triples.
    expect(repoMocks.updateSecrets).toHaveBeenCalledTimes(1)
    const stored = repoMocks.updateSecrets.mock.calls[0][2] as { secretsCiphertext: Buffer; secretsKeyVersion: number }
    expect(stored.secretsKeyVersion).toBe(1)
    const blob = decryptSecrets<{ apiKey: string; webhooks: AccountedWebhookSubscriptionSecret[] }>(stored.secretsCiphertext, stored.secretsKeyVersion)
    expect(blob.apiKey).toBe('gnubok_sk_test_k')
    expect(blob.webhooks).toEqual(TRIPLES)
  })

  it('a fresh token per connect retires a previous one (the URL is a capability)', async () => {
    repoMocks.getConnection.mockResolvedValue(row({ webhook_token: 'old-token' }))
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(repoMocks.setWebhookToken).toHaveBeenCalledWith('user_1', 'accounted', 'tok_' + 'x'.repeat(43))
  })

  it('a reconnect deletes the previous three subscriptions BEFORE the secrets blob is overwritten (S3)', async () => {
    // The old row carries the only record of the previous triples — its
    // encrypted secrets blob. `upsertConnection` below would overwrite it.
    const oldBlob = encryptSecrets({ apiKey: 'gnubok_sk_old', webhooks: TRIPLES } as unknown as Record<string, unknown>)
    repoMocks.getConnection.mockResolvedValue(
      row({ webhook_token: 'old-token', secrets_ciphertext: oldBlob.ciphertext, secrets_key_version: oldBlob.keyVersion }),
    )
    const calls: string[] = []
    repoMocks.upsertConnection.mockImplementation(async () => {
      calls.push('upsert')
      return row()
    })
    deleteSpy.mockImplementation(async () => {
      calls.push('delete')
      return { deleted: 3, failed: 0 }
    })

    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })

    // Teardown runs while the old secrets are still in hand — before the
    // overwrite that would lose them.
    expect(calls).toEqual(['delete', 'upsert'])
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    const del = deleteSpy.mock.calls[0][0] as { apiKey: string; companyId: string; subscriptions: AccountedWebhookSubscriptionSecret[] }
    expect(del.apiKey).toBe('gnubok_sk_old')
    expect(del.companyId).toBe('comp_1')
    expect(del.subscriptions).toEqual(TRIPLES)
  })

  it('a teardown the provider refuses (rotated key) is not silent: one warn event with the failed count, and the reconnect still proceeds (S-E)', async () => {
    const oldBlob = encryptSecrets({ apiKey: 'gnubok_sk_old', webhooks: TRIPLES } as unknown as Record<string, unknown>)
    repoMocks.getConnection.mockResolvedValue(
      row({ webhook_token: 'old-token', secrets_ciphertext: oldBlob.ciphertext, secrets_key_version: oldBlob.keyVersion }),
    )
    deleteSpy.mockResolvedValue({ deleted: 0, failed: 3 })

    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })

    expect(saved.status).toBe('connected')
    expect(repoMocks.upsertConnection).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledWith('warn', {
      event: 'accounting.webhook.teardown_failed',
      userId: 'user_1',
      provider: 'accounted',
      deleted: 0,
      failed: 3,
    })
    // A teardown that deleted everything says nothing.
    emitSpy.mockClear()
    deleteSpy.mockResolvedValue({ deleted: 3, failed: 0 })
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('a first connect never tears anything down (S3 is a reconnect-only step)', async () => {
    repoMocks.getConnection.mockResolvedValue(null)
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('no public API origin configured → the row is flagged needs_attention and NOTHING is registered (S5)', async () => {
    delete process.env.HAVEN_API_URL
    delete process.env.PUBLIC_API_URL
    try {
      const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
      // The row stays stored and connected — the feed half works; the flag
      // names the one thing the deployment must state.
      expect(saved.status).toBe('connected')
      expect(flagSpy).toHaveBeenCalledTimes(1)
      const [userId, providerId, status, reason] = flagSpy.mock.calls[0] as [string, string, string, string]
      expect(userId).toBe('user_1')
      expect(providerId).toBe('accounted')
      expect(status).toBe('needs_attention')
      expect(reason).toBe('no public API origin configured')
      // Fail closed: no token issued, no callback registered, no triples stored.
      expect(repoMocks.setWebhookToken).not.toHaveBeenCalled()
      expect(registerSpy).not.toHaveBeenCalled()
      expect(repoMocks.updateSecrets).not.toHaveBeenCalled()
      expect(deleteSpy).not.toHaveBeenCalled()
    } finally {
      process.env.HAVEN_API_URL = 'https://api.example.test'
    }
  })
  it('a registration failure leaves the row connected but flags needs_attention with the reason — never half-subscribed and never a thrown connect', async () => {
    // The real failure shape: the registration wrapper throws
    // AccountedWebhookRegistrationError whose message names the cause.
    registerSpy.mockRejectedValue(new AccountedWebhookRegistrationError('Accounted webhook registration failed: HTTP 403: INSUFFICIENT_SCOPE for period.locked.', new Error('HTTP 403')))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(saved.status).toBe('connected')
    expect(flagSpy).toHaveBeenCalledTimes(1)
    const [userId, providerId, status, reason] = flagSpy.mock.calls[0] as [string, string, string, string]
    expect(userId).toBe('user_1')
    expect(providerId).toBe('accounted')
    expect(status).toBe('needs_attention')
    expect(reason).toContain('webhook subscription failed')
    expect(reason).toContain('period.locked')
    // The failure path does NOT rewrite the secrets with triples.
    expect(repoMocks.updateSecrets).not.toHaveBeenCalled()
  })

  it('an unexpected failure shape still flags needs_attention with the error name, and never throws out of connect', async () => {
    registerSpy.mockRejectedValue(new Error('socket hang up'))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(saved.status).toBe('connected')
    const [, , status, reason] = flagSpy.mock.calls[0] as [string, string, string, string]
    expect(status).toBe('needs_attention')
    expect(reason).toBe('webhook subscription failed — Error')
  })

  it('a provider with no webhook descriptor connects without touching the webhook half (Fortnox path unchanged)', async () => {
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'k' })
    expect(saved.status).toBe('connected')
    expect(registerSpy).not.toHaveBeenCalled()
    expect(repoMocks.setWebhookToken).not.toHaveBeenCalled()
    expect(repoMocks.updateSecrets).not.toHaveBeenCalled()
    expect(flagSpy).not.toHaveBeenCalled()
  })

  it('a provider whose company read returned no id skips the webhook half entirely', async () => {
    const connector = CONNECTOR as unknown as { getCompanyInfo: ReturnType<typeof vi.fn> }
    connector.getCompanyInfo.mockResolvedValue({
      externalCompanyId: null,
      name: null,
      baseCurrency: null,
      scopeRefused: false,
    })
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(registerSpy).not.toHaveBeenCalled()
    expect(repoMocks.setWebhookToken).not.toHaveBeenCalled()
  })

  it('the connection returned after the webhook step is the UPDATED row', async () => {
    repoMocks.getConnection.mockResolvedValue(row({ webhook_token: 'tok_fresh' }))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(saved.webhook_token).toBe('tok_fresh')
  })

  // ── The endpoint-verification handshake (#3019 delta) ──────────────────────
  //
  // The provider will not dispatch a single event to an unverified endpoint.
  // The flow runs `POST …/webhooks/{id}/verify` once per subscription, in
  // creation order, AFTER the triples are stored — and best effort: a failure
  // never fails the connect and never changes the connection status.

  it('runs the verification handshake once per subscription, in creation order, AFTER the secrets are stored', async () => {
    const calls: string[] = []
    repoMocks.updateSecrets.mockImplementation(async () => {
      calls.push('re-encrypt')
    })
    verifySpy.mockImplementation(async (input: { webhookId: string }) => {
      calls.push(`verify:${input.webhookId}`)
      return { verificationStatus: 'verified' }
    })

    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })

    // The triples must be persisted BEFORE the handshake: they are the record
    // of what to verify, and the receiver must already answer the callback URL.
    expect(calls).toEqual(['re-encrypt', 'verify:wh_1', 'verify:wh_2', 'verify:wh_3'])
    expect(verifySpy).toHaveBeenCalledTimes(3)
    // Each call carries the PLAINTEXT key, the company, and that subscription's id.
    expect(verifySpy.mock.calls[0][0]).toEqual({ apiKey: 'gnubok_sk_test_k', companyId: 'comp_1', webhookId: 'wh_1' })
    expect(verifySpy.mock.calls[2][0]).toEqual({ apiKey: 'gnubok_sk_test_k', companyId: 'comp_1', webhookId: 'wh_3' })
  })

  it('a verify failure does not fail the connect and does not change the connection status — one warn per failure, provider code only', async () => {
    const refusal = new ProviderError(
      'Accounted POST /api/v1/companies/comp_1/webhooks/wh_1/verify failed (HTTP 422: WEBHOOK_VERIFICATION_FAILED).',
      422,
      'accounted',
    )
    ;(refusal as ProviderError & { providerCode?: string }).providerCode = 'WEBHOOK_VERIFICATION_FAILED'
    verifySpy.mockRejectedValueOnce(refusal)

    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })

    // The connect succeeded and the row is untouched: the feed still works,
    // and the subscription's own verification_status is the source of truth.
    expect(saved.status).toBe('connected')
    expect(flagSpy).not.toHaveBeenCalled()
    // One warn line, carrying the provider's CODE — never the key, never a
    // signing secret, never the provider's free-text message.
    expect(emitSpy).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledWith('warn', {
      event: 'accounting.webhook.verification_failed',
      userId: 'user_1',
      provider: 'accounted',
      eventType: 'journal_entry.committed',
      code: 'WEBHOOK_VERIFICATION_FAILED',
    })
    // The remaining subscriptions were still verified — one failure does not
    // stop the loop.
    expect(verifySpy).toHaveBeenCalledTimes(3)
  })

  it('a verify failure with no provider code logs the HTTP status, and a non-provider error logs its name', async () => {
    verifySpy.mockRejectedValueOnce(new ProviderError('Accounted POST … failed (HTTP 500).', 500, 'accounted'))
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect((emitSpy.mock.calls[0][1] as { code: string }).code).toBe('HTTP 500')

    emitSpy.mockClear()
    verifySpy.mockRejectedValueOnce(new Error('socket hang up'))
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect((emitSpy.mock.calls[0][1] as { code: string }).code).toBe('Error')
  })

  it('a registration failure runs no verify at all (there is nothing to verify)', async () => {
    registerSpy.mockRejectedValue(new AccountedWebhookRegistrationError('Accounted webhook registration failed: HTTP 403.', new Error('HTTP 403')))
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(verifySpy).not.toHaveBeenCalled()
  })

  it('a secrets-write failure runs no verify: the triples never landed, so the provider must not start dispatching', async () => {
    // Verifying a subscription whose signing secret Haven failed to store
    // would make the provider deliver events we could never verify (400
    // bad_signature) — worse than an unverified subscription.
    repoMocks.updateSecrets.mockRejectedValue(new Error('db down'))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy, verify: verifySpy } })
    expect(saved.status).toBe('connected')
    expect(flagSpy).toHaveBeenCalledTimes(1)
    expect(verifySpy).not.toHaveBeenCalled()
  })
})
