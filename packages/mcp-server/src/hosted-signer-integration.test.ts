/**
 * Hosted MCP + Edge Signer integration test.
 *
 * Exercises the full non-custodial payment flow:
 *   1. Hosted MCP constructs the funding intent (haven_pay_x402_quote)
 *   2. Local signer signs the funding hash and records x402 binding (haven_sign)
 *   3. Hosted MCP relays the signature to Haven (haven_submit)
 *   4. Local signer builds the EIP-3009 merchant header (haven_x402_sign_header)
 *   5. Agent retries the merchant
 *
 * Critical invariants asserted:
 *   - The delegate key NEVER appears in any HTTP request to the hosted MCP or Haven.
 *   - Funding relay sends only { payment_id, signature } to hosted MCP.
 *     Paid MCP completion may send a signed merchant payment_header, never a key.
 *   - The payment header produced by the signer is spec-compliant wire format.
 *
 * docs/architecture/06-hosted-mcp-connect-flow.md
 * docs/architecture/07-edge-signer.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HavenClient, buildX402ExpectedMessage } from '@haven_ai/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { createEdgeSigner, createToolHandlers as createSignerHandlers } from '@haven_ai/signer'
import { createToolHandlers as createHostedHandlers, type ToolPayload } from './tools.js'
import { createHostedHavenClient } from './server.js'

// ── Test keys (well-known Hardhat accounts, never used for real funds) ────────
// Hosted MCP delegate key is intentionally NOT included — simulates keyless server.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

// ── x402 fixtures ─────────────────────────────────────────────────────────────
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://merchant.test/data', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      maxAmountRequired: '1500000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
    },
  ],
}

const FUNDING_HASH = '0x' + 'cd'.repeat(32)
const FUNDING_PAYMENT_ID = 'pay_x402_integration'
const DELEGATE_ADDR = privateKeyToAccount(DELEGATE_KEY).address

/**
 * Build x402 expected context in the snake_case shape the signer tool schema
 * requires (same as what haven_pay_x402_quote returns in x402.expected).
 */
async function makeX402ExpectedAuth() {
  // camelCase keys for SDK's buildX402ExpectedMessage
  const context = {
    paymentId: FUNDING_PAYMENT_ID,
    payloadHash: FUNDING_HASH,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
    amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  const auth = {
    version: 1 as const,
    message,
    signature: await account.signMessage({ message }),
    signer: BINDING_SIGNER,
  }
  // Return snake_case (what the signer Zod schema validates) and camelCase
  // (what createEdgeSigner.signX402FundingHash expects).
  return {
    // snake_case for haven_sign tool input
    snake: {
      payment_id: context.paymentId,
      payload_hash: context.payloadHash,
      resource_url: context.resourceUrl,
      merchant_to: context.merchantTo,
      amount: context.amount,
      asset: context.asset,
      network: context.network,
      auth,
    },
    // camelCase for createEdgeSigner.signX402FundingHash
    camel: {
      paymentId: context.paymentId,
      payloadHash: context.payloadHash,
      resourceUrl: context.resourceUrl,
      merchantTo: context.merchantTo,
      amount: context.amount,
      asset: context.asset,
      network: context.network,
      auth,
    },
  }
}

// ── Network call recorder ──────────────────────────────────────────────────────
interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | null
  headers: Record<string, string>
}

let capturedCalls: CapturedCall[]

function stubHavenApi() {
  capturedCalls = []
  const x402ExpectedAuth = {
    version: 1,
    message: 'Haven x402 expected context v1',
    signature: '0x' + '11'.repeat(65),
    signer: BINDING_SIGNER,
  }

  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body as string) : null
    capturedCalls.push({
      url,
      method,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    })

    // ── Haven API stubs ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/machine-payments/agent') {
      return jsonResponse(200, {
        id: 'agt_1',
        name: 'Integration Test Agent',
        status: 'active',
        delegate_address: DELEGATE_ADDR,
        chain_id: 8453,
      })
    }
    if (method === 'POST' && path === '/x402') {
      return jsonResponse(201, {
        payment_id: FUNDING_PAYMENT_ID,
        status: 'pending_signature',
        merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
        x402_expected_auth: x402ExpectedAuth,
        sign_data: { hash: FUNDING_HASH },
        expires_at: '2099-01-01T00:00:00.000Z',
      })
    }
    if (method === 'POST' && path === `/payments/${FUNDING_PAYMENT_ID}/sign`) {
      return jsonResponse(200, {
        status: 'confirmed',
        tx_hash: '0x' + 'ef'.repeat(32),
      })
    }

    return jsonResponse(404, { error: `No stub for ${method} ${path}` })
  })
}

function jsonResponse(status: number, body: unknown) {
  const responseHeaders = new Headers({ 'content-type': 'application/json' })
  const bodySnapshot = body
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: async () => bodySnapshot,
    clone: () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      json: async () => bodySnapshot,
    }),
  }
}

function ok<T = unknown>(result: ToolPayload): T {
  if (!result.success) {
    throw new Error(`Expected success, got failure: [${result.code}] ${result.message}`)
  }
  return (result as { success: true; data: T }).data
}

// ── Test suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  stubHavenApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Hosted MCP + Edge Signer integration', () => {
  it('completes the x402 construct → sign → submit → header flow, key never in hosted traffic', async () => {
    // ── Setup ────────────────────────────────────────────────────────────────
    // Hosted MCP: keyless client (no delegate key)
    const havenKeyless = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'http://haven.test',
    })
    const hostedHandlers = createHostedHandlers(havenKeyless)

    // Edge signer: holds the key locally, configured with binding signer
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)

    // Pre-build x402 expected auth (normally returned by hosted haven_pay_x402_quote)
    const x402Expected = await makeX402ExpectedAuth()

    // ── Step 1: Hosted MCP constructs the x402 funding intent ────────────────
    const quoteResult = ok<{
      payment_id: string
      payload_hash: string
      x402: { expected: Record<string, unknown> }
    }>(await hostedHandlers.haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(quoteResult.payment_id).toBe(FUNDING_PAYMENT_ID)
    expect(quoteResult.payload_hash).toBe(FUNDING_HASH)
    expect(quoteResult.x402?.expected).toBeDefined()

    // ── Step 2: Edge signer signs the funding hash locally ───────────────────
    // Pass x402_expected in snake_case (the signer tool's Zod schema format).
    const signResult = ok<{ signature: string; x402_binding: string }>(
      await signerHandlers.haven_sign({
        payload_hash: FUNDING_HASH,
        x402_expected: x402Expected.snake,
      }),
    )

    expect(signResult.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(signResult.x402_binding).toBeTruthy()

    // ── Step 3: Hosted MCP relays the signature to Haven ────────────────────
    const submitResult = ok<{ status: string; tx_hash: string }>(
      await hostedHandlers.haven_submit({
        payment_id: FUNDING_PAYMENT_ID,
        signature: signResult.signature,
      }),
    )

    expect(submitResult.status).toBe('confirmed')
    expect(submitResult.tx_hash).toBeTruthy()

    // ── Step 4: Edge signer builds the EIP-3009 X-PAYMENT header ─────────────
    const headerResult = ok<{ payment_header: string }>(
      await signerHandlers.haven_x402_sign_header({
        payment_required: PAYMENT_REQUIRED,
        x402_binding: signResult.x402_binding,
      }),
    )

    const paymentHeader = headerResult.payment_header
    expect(typeof paymentHeader).toBe('string')
    expect(paymentHeader.length).toBeGreaterThan(0)

    // ── Custody invariant: delegate key NEVER in hosted MCP / Haven requests ─
    // All captured calls are to the Haven API (haven.test) — no merchant calls.
    const havenCalls = capturedCalls.filter((c) => c.url.includes('haven.test'))
    const wire = JSON.stringify(havenCalls)
    expect(wire).not.toContain(DELEGATE_KEY)
    expect(wire).not.toContain('delegate_key')
    expect(wire).not.toContain('private_key')

    // Only the relay call should carry signature data.
    const submitCall = havenCalls.find((c) => c.url.includes('/sign'))
    expect(submitCall?.body).toEqual({ signature: signResult.signature })

    // The construct call carries payTo (delegate address) but never the key.
    const constructCall = havenCalls.find((c) => c.url.endsWith('/x402'))
    expect(constructCall?.body).toMatchObject({ payTo: DELEGATE_ADDR })
    expect(JSON.stringify(constructCall?.body ?? {})).not.toContain(DELEGATE_KEY)
  })

  it('wire format: decoded payment header has {x402Version, accepted, payload} with key-bound authorization.from', async () => {
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)
    const delegateAddress = edgeSigner.delegateAddress

    const x402Expected = await makeX402ExpectedAuth()
    const funding = edgeSigner.signX402FundingHash(FUNDING_HASH, x402Expected.camel)
    const result = ok<{ payment_header: string }>(
      await signerHandlers.haven_x402_sign_header({
        payment_required: PAYMENT_REQUIRED,
        x402_binding: funding.x402Binding,
      }),
    )

    // Decode the header and assert spec shape.
    const decoded = JSON.parse(atob(result.payment_header)) as Record<string, unknown>
    const topLevelKeys = Object.keys(decoded).sort()
    expect(topLevelKeys).toEqual(['accepted', 'payload', 'x402Version'])
    expect(decoded.x402Version).toBe(2)

    const payload = decoded.payload as Record<string, unknown>
    expect(typeof payload.signature).toBe('string')

    const authorization = payload.authorization as Record<string, unknown>
    expect(authorization).toBeDefined()
    // The EIP-3009 `from` field must be the delegate address — proves the
    // header is key-bound and can't be replayed from a different key.
    expect((authorization.from as string).toLowerCase()).toBe(delegateAddress.toLowerCase())
  })

  it('hosted MCP never has a signing path (custody guard)', () => {
    // The hosted client must be constructed without a delegate key.
    // An api-key-only client has no delegate address and no signing path.
    const client = createHostedHavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    expect(client.delegateAddress).toBeUndefined()
  })
})
