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

const { registerSpy, flagSpy } = vi.hoisted(() => ({
  registerSpy: vi.fn(),
  flagSpy: vi.fn(),
}))
vi.mock('../ops-signals.js', () => ({ flagConnectionStatus: flagSpy }))
vi.mock('../accounted-webhooks.js', () => ({
  AccountedWebhookRegistrationError: class extends Error {
    constructor(message: string) {
      super(message)
    }
  },
  registerAccountedWebhooks: registerSpy,
}))

beforeAll(() => {
  process.env.HAVEN_SECRETS_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' // 32 bytes, base64
})
afterAll(() => {
  delete process.env.HAVEN_SECRETS_KEY
})

import { connectWithApiKey } from '../api-key-flow.js'
import { AccountedWebhookRegistrationError } from '../accounted-webhooks.js'
import { decryptSecrets } from '../../../infra/secrets.js'
import type { AccountingConnectionRow } from '../../../infra/repositories/accounting-connections.js'
import type { AccountingProvider, ProviderCompanyInfo } from '../provider.js'
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

    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy } })

    // The order the issue demands: row → token → registration → secrets.
    expect(calls).toEqual(['upsert', 'token', 'register', 're-encrypt'])
    // The registration got the PLAINTEXT key and the same token that was set.
    expect(registerSpy).toHaveBeenCalledTimes(1)
    const reg = registerSpy.mock.calls[0][0] as { secrets: { apiKey: string }; companyId: string; token: string }
    expect(reg.secrets.apiKey).toBe('gnubok_sk_test_k')
    expect(reg.companyId).toBe('comp_1')
    expect(reg.token).toBe(repoMocks.newWebhookToken())
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
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy } })
    expect(repoMocks.setWebhookToken).toHaveBeenCalledWith('user_1', 'accounted', 'tok_' + 'x'.repeat(43))
  })
  it('a registration failure leaves the row connected but flags needs_attention with the reason — never half-subscribed and never a thrown connect', async () => {
    // The real failure shape: the registration wrapper throws
    // AccountedWebhookRegistrationError whose message names the cause.
    registerSpy.mockRejectedValue(new AccountedWebhookRegistrationError('Accounted webhook registration failed: HTTP 403: INSUFFICIENT_SCOPE for period.locked.', new Error('HTTP 403')))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy } })
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
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'k', webhooks: { register: registerSpy } })
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
    await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'k', webhooks: { register: registerSpy } })
    expect(registerSpy).not.toHaveBeenCalled()
    expect(repoMocks.setWebhookToken).not.toHaveBeenCalled()
  })

  it('the connection returned after the webhook step is the UPDATED row', async () => {
    repoMocks.getConnection.mockResolvedValue(row({ webhook_token: 'tok_fresh' }))
    const saved = await connectWithApiKey({ provider: PROVIDER, connector: CONNECTOR, userId: 'user_1', apiKey: 'gnubok_sk_test_k', webhooks: { register: registerSpy } })
    expect(saved.webhook_token).toBe('tok_fresh')
  })
})
