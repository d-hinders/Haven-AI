/**
 * #3768 — merchant-issued credentials are withheld from the agent-facing
 * `result`.
 *
 * Unit half: the recognizer itself (JWT shape, credential-named keys, embedded
 * JWTs in longer strings, and everything it must NOT touch — money, settled
 * markers, hashes, product names). Handler half: the Soundside prod-QA shape
 * (payment 79084a5e, 2026-10-08 — `x402_session_token` JWT + `wallet_link`
 * URL, both bound to the delegate EOA, inside `result.structuredContent`)
 * through all three settled arms — eip3009 settle, erc7710 settle and
 * haven_complete_mcp_tool — RED by default, verbatim under the explicit
 * `include_merchant_credentials: true` opt-in, and redacted in the
 * MERCHANT_REJECTED_AFTER_FUNDING refusal echo. The acceptance criterion is
 * the negative assertion: the credential value must not appear verbatim in
 * the response.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { createToolHandlers } from '../tools.js'
import {
  clearCalls,
  fail,
  installSharedFixtureLifecycle,
  keylessClient,
  mintPaymentHeaders,
  ok,
  stubFetch,
  VALID_PAYMENT_HEADER_REF,
} from '../test-support/hosted-mcp.js'
import {
  MERCHANT_CREDENTIAL_WITHHELD,
  MERCHANT_JWT_REDACTED,
  redactMerchantCredentials,
} from './paid-mcp-completion.js'

installSharedFixtureLifecycle()

beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeAll(async () => {
  await mintPaymentHeaders()
})

// A structurally real JWT (header.payload.signature, base64url, 16+ chars
// each) standing in for the Soundside x402_session_token.
const SOUNDside_SESSION_TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJkZWxlZ2F0ZSJ9', 'c2lnbmF0dXJlX3BhcnQ'].join('.')
// The Soundside wallet_link: a URL whose query carries the JWT.
const SOUNDSIDE_WALLET_LINK = `https://soundside.example/link?token=${SOUNDside_SESSION_TOKEN}`

/** The prod-QA body: the JSON-RPC envelope the merchant answered tools/call with. */
function soundsideBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'haven-mcp-test',
    result: {
      content: [{ type: 'text', text: `Session started: ${SOUNDside_SESSION_TOKEN}` }],
      structuredContent: {
        status: 'created',
        x402_session_token: SOUNDside_SESSION_TOKEN,
        wallet_link: SOUNDSIDE_WALLET_LINK,
        summary: { product_name: 'Soundside create_text' },
      },
      isError: false,
    },
  }
}

describe('redactMerchantCredentials (recognizer)', () => {
  it('redacts a JWT-shaped string by shape, whatever the key is named', () => {
    const out = redactMerchantCredentials({ someRandomKey: SOUNDside_SESSION_TOKEN }) as Record<string, string>
    expect(out.someRandomKey).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('withholds a whole value under a credential-named key, even a non-JWT opaque token', () => {
    const out = redactMerchantCredentials({
      api_key: 'sk-live-opaque-credential-value',
      X_Access_Token: 'opaque-header-token',
      session: 'sess_abc123',
      nested: { refresh_token: 'rt_opaque' },
    }) as Record<string, unknown>
    expect(out.api_key).toBe(MERCHANT_CREDENTIAL_WITHHELD)
    expect(out.X_Access_Token).toBe(MERCHANT_CREDENTIAL_WITHHELD)
    expect(out.session).toBe(MERCHANT_CREDENTIAL_WITHHELD)
    expect((out.nested as Record<string, string>).refresh_token).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('withholds a wallet_link URL whole (the URL itself is the bearer credential)', () => {
    const out = redactMerchantCredentials({ wallet_link: SOUNDSIDE_WALLET_LINK }) as Record<string, string>
    expect(out.wallet_link).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('strips an embedded JWT from a longer string under a non-credential key', () => {
    const out = redactMerchantCredentials({
      url: `https://merchant.example/callback?token=${SOUNDside_SESSION_TOKEN}`,
    }) as Record<string, string>
    expect(out.url).toBe(`https://merchant.example/callback?token=${MERCHANT_JWT_REDACTED}`)
  })

  it('strips an embedded JWT from merchant content text blocks', () => {
    const out = redactMerchantCredentials({
      content: [{ type: 'text', text: `Session started: ${SOUNDside_SESSION_TOKEN} — enjoy.` }],
    }) as { content: { text: string }[] }
    expect(out.content[0]!.text).toBe(`Session started: ${MERCHANT_JWT_REDACTED} — enjoy.`)
  })

  it('never touches money fields, settled markers, hashes, product names or plain URLs', () => {
    const body = {
      structuredContent: {
        amount: '500',
        settled: true,
        delivered: true,
        settlement_tx_hash: '0x' + 'ab'.repeat(32),
        product_name: 'Soundside create_text',
        receipt_url: 'https://soundside.example/receipt/abc',
        created_at: '2026-10-08T12:00:00.000Z',
        summary: { invoice_id: 'inv-123', product_name: 'Soundside create_text' },
      },
    }
    expect(redactMerchantCredentials(body)).toEqual(body)
  })

  it('does not mutate its input and passes arrays, nulls and primitives through', () => {
    const body = soundsideBody()
    const snapshot = JSON.stringify(body)
    redactMerchantCredentials(body)
    expect(JSON.stringify(body)).toBe(snapshot)
    expect(redactMerchantCredentials(null)).toBeNull()
    expect(redactMerchantCredentials(42)).toBe(42)
    expect(redactMerchantCredentials(['a', 1, null])).toEqual(['a', 1, null])
  })

  it('keeps empty strings empty under credential keys', () => {
    const out = redactMerchantCredentials({ api_key: '' }) as Record<string, string>
    expect(out.api_key).toBe('')
  })

  it('returns a clean body by reference — the #1310 pass-through contract holds', () => {
    const body = { structuredContent: { product_name: 'Soundside create_text' }, result: 'ok' }
    expect(redactMerchantCredentials(body)).toBe(body)
  })
})

// ── Handler-level: the Soundside shape through the three settled arms ─────────

describe('merchant credential redaction over the settled result (#3768)', () => {
  const SIG = '0x' + '11'.repeat(65)

  it('withholds the Soundside credentials from the settled eip3009 result and keeps settled:true', async () => {
    stubFetch({
      'POST /payments/pay_3768/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new Error('No stored merchant call context for this intent'),
    )
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: soundsideBody(),
      settlementTxHash: '0x' + 'ab'.repeat(32),
      evidenceOutcome: { outcome: 'confirmed' },
    })
    vi.spyOn(haven, 'getPostPurchaseAllowanceSummary').mockResolvedValue({
      allowance: null,
      warnings: [],
      payment: null,
    })

    const result = ok<Record<string, unknown>>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_3768',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    const data = result.data as Record<string, unknown>
    // Money truth is untouched.
    expect(data.settled).toBe(true)
    // THE acceptance criterion: neither credential appears verbatim anywhere.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SOUNDside_SESSION_TOKEN)
    const structured = (((data.result as Record<string, unknown>).result as Record<string, unknown>)
      .structuredContent ?? {}) as Record<string, unknown>
    expect(structured.x402_session_token).toBe(MERCHANT_CREDENTIAL_WITHHELD)
    expect(structured.wallet_link).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('returns the merchant body verbatim when the caller passes include_merchant_credentials=true', async () => {
    stubFetch({
      'POST /payments/pay_3768/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(new Error('No stored context'))
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: soundsideBody(),
      settlementTxHash: '0x' + 'ab'.repeat(32),
      evidenceOutcome: { outcome: 'confirmed' },
    })
    vi.spyOn(haven, 'getPostPurchaseAllowanceSummary').mockResolvedValue({
      allowance: null,
      warnings: [],
      payment: null,
    })

    const result = ok<Record<string, unknown>>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_3768',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        include_merchant_credentials: true,
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    const data = result.data as Record<string, unknown>
    expect(data.settled).toBe(true)
    const structured = (((data.result as Record<string, unknown>).result as Record<string, unknown>)
      .structuredContent ?? {}) as Record<string, unknown>
    expect(structured.x402_session_token).toBe(SOUNDside_SESSION_TOKEN)
    expect(structured.wallet_link).toBe(SOUNDSIDE_WALLET_LINK)
  })

  it('withholds the credentials on the settled erc7710 arm too', async () => {
    stubFetch({})
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(new Error('No stored context'))
    // No payment_header => erc7710: the signature IS the settlement child.
    vi.spyOn(haven, 'submitX402Erc7710').mockResolvedValue('HEADER_FROM_HAVEN')
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: soundsideBody(),
      settlementTxHash: '0x' + 'cd'.repeat(32),
      evidenceOutcome: { outcome: 'confirmed' },
    })
    vi.spyOn(haven, 'getPostPurchaseAllowanceSummary').mockResolvedValue({
      allowance: null,
      warnings: [],
      payment: null,
    })

    const result = ok<Record<string, unknown>>(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_3768_7710',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
      }),
    )
    const data = result.data as Record<string, unknown>
    expect(data.settled).toBe(true)
    expect(data.settlement_scheme).toBe('erc7710')
    expect(JSON.stringify(result)).not.toContain(SOUNDside_SESSION_TOKEN)
    const structured = (((data.result as Record<string, unknown>).result as Record<string, unknown>)
      .structuredContent ?? {}) as Record<string, unknown>
    expect(structured.x402_session_token).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('withholds the credentials on the decomposed haven_complete_mcp_tool arm', async () => {
    stubFetch({})
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(new Error('No stored context'))
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200,
      ok: true,
      body: soundsideBody(),
      settlementTxHash: '0x' + 'ef'.repeat(32),
    })

    const result = ok<Record<string, unknown>>(
      await createToolHandlers(haven).haven_complete_mcp_tool({
        payment_id: 'pay_3768_complete',
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        payment_header: 'eyJ4IjoxfQ==',
      }),
    )
    const data = result.data as Record<string, unknown>
    expect(data.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SOUNDside_SESSION_TOKEN)
    const structured = (((data.result as Record<string, unknown>).result as Record<string, unknown>)
      .structuredContent ?? {}) as Record<string, unknown>
    expect(structured.x402_session_token).toBe(MERCHANT_CREDENTIAL_WITHHELD)
  })

  it('redacts the bounded Merchant response echo of a MERCHANT_REJECTED_AFTER_FUNDING refusal', async () => {
    stubFetch({
      'POST /payments/pay_3768_refused/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(new Error('No stored context'))
    vi.spyOn(haven, 'ensureFundingConfirmed').mockResolvedValue(undefined)
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 402,
      ok: false,
      body: { error: 'payment_required', x402_session_token: SOUNDside_SESSION_TOKEN },
    })

    const payload = fail(
      await createToolHandlers(haven).haven_settle_mcp_tool({
        payment_id: 'pay_3768_refused',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'create_text',
        arguments: { prompt: 'Hello' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    expect(payload.message).not.toContain(SOUNDside_SESSION_TOKEN)
    expect(payload.message).toContain(MERCHANT_CREDENTIAL_WITHHELD)
  })
})
