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
 * Scope, versus its sibling (#1187). `x402-expected-wire-contract.test.ts`
 * pins the expected-context MESSAGE — byte-identical across all four hops,
 * both versions, every drift refused. This file pins the FLOW around it: that
 * the four tool calls compose, that the header comes out spec-shaped, and that
 * no key ever reaches hosted traffic. Neither subsumes the other.
 *
 * It used to exercise **only v1**, with a hand-built context. That is how a
 * `packages/signer/dist` four weeks behind its source sat undetected (#1154):
 * the v2 entry point it lacked, `signX402FundingTypedData`, simply did not
 * exist in that build, and nothing here called it. The v2 case below closes
 * that hole, and takes its context from the REAL backend producer rather than
 * a local copy — a hand-written fixture cannot drift, which sounds like a
 * virtue until it is the only thing standing between you and a stale build.
 *
 * docs/architecture/06-hosted-mcp-connect-flow.md
 * docs/architecture/07-edge-signer.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod/v3'
import { HavenClient, buildX402ExpectedMessage } from '@haven_ai/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'
import {
  createEdgeSigner,
  createToolHandlers as createSignerHandlers,
  signerCompatibility,
  SIGNER_CAPABILITY_KEY,
} from '@haven_ai/signer'
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
 * The EIP-712 payload a delegation-rail account validates. Shape only — what
 * the contract turns on is the digest, and the v2 context commits to exactly
 * that. Signing this exercises `signX402FundingTypedData`, the entry point a
 * stale signer build simply does not have (#1154/#1187).
 */
const TYPED_DATA = {
  domain: { name: 'HybridDeleGator', version: '1', chainId: 84532, verifyingContract: DELEGATE_ADDR },
  types: {
    PackedUserOperation: [
      { name: 'sender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  primaryType: 'PackedUserOperation',
  message: { sender: DELEGATE_ADDR, nonce: '7' },
} as Record<string, unknown>

/**
 * A payload shaped like a LIVE delegation-rail redemption (#1255): the full
 * PackedUserOperation type set and a multi-KB callData — the size class whose
 * agent-side copy-through broke in production. Built exactly like the
 * backend's `userOpTypedData` output (all bigints pre-stringified).
 */
const REALISTIC_TYPED_DATA = {
  domain: { name: 'HybridDeleGator', version: '1', chainId: 8453, verifyingContract: DELEGATE_ADDR },
  types: {
    PackedUserOperation: [
      { name: 'sender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' },
      { name: 'accountGasLimits', type: 'bytes32' },
      { name: 'preVerificationGas', type: 'uint256' },
      { name: 'gasFees', type: 'bytes32' },
      { name: 'paymasterAndData', type: 'bytes' },
      { name: 'entryPoint', type: 'address' },
    ],
  },
  primaryType: 'PackedUserOperation',
  message: {
    sender: DELEGATE_ADDR,
    // Keyed 4337 nonce — a >2^53 value, stringified like the backend does.
    nonce: (0x1n << 64n | 5n).toString(),
    initCode: '0x',
    callData: '0x' + 'ab'.repeat(4000),
    accountGasLimits: '0x' + '11'.repeat(32),
    preVerificationGas: '60000',
    gasFees: '0x' + '22'.repeat(32),
    paymasterAndData: '0x' + 'cd'.repeat(100),
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  },
} as Record<string, unknown>

/**
 * Build x402 expected context in the snake_case shape the signer tool schema
 * requires (same as what haven_pay_x402_quote returns in x402.expected).
 */
async function makeX402ExpectedAuth(
  rail: 'legacy' | 'delegation' = 'legacy',
  typedData: Record<string, unknown> = TYPED_DATA,
) {
  // camelCase keys for SDK's buildX402ExpectedMessage
  const context = {
    paymentId: FUNDING_PAYMENT_ID,
    payloadHash: FUNDING_HASH,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
    amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    // expires_at is folded into the signed binding and now required by the
    // signer tool schema, mirroring the hosted server's x402.expected output.
    expiresAt: '2099-01-01T00:00:00.000Z',
    // v2 commits to the digest of the typed data actually delivered. Its
    // presence is what makes the context v2 — the version is derived, never
    // announced (#1138).
    ...(rail === 'delegation' ? { typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]) } : {}),
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  const auth = {
    version: (rail === 'delegation' ? 2 : 1) as 1 | 2,
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
      expires_at: context.expiresAt,
      ...(context.typedDataHash ? { typed_data_hash: context.typedDataHash } : {}),
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
      expiresAt: context.expiresAt,
      ...(context.typedDataHash ? { typedDataHash: context.typedDataHash } : {}),
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

function stubHavenApi(
  rail: 'legacy' | 'delegation' = 'legacy',
  typedData: Record<string, unknown> = TYPED_DATA,
) {
  capturedCalls = []
  // The 201 body is a placeholder for the FLOW assertions; the message-level
  // contract is the sibling file's job. What matters here is the sign_data
  // SHAPE, which is what routes the signer down the v1 or v2 path.
  const x402ExpectedAuth = {
    version: rail === 'delegation' ? 2 : 1,
    message: `Haven x402 expected context v${rail === 'delegation' ? 2 : 1}`,
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
        // On the delegation rail the account validates typed data, and the
        // hosted surface must pass BOTH through — the signer picks the path.
        sign_data:
          rail === 'delegation'
            ? { hash: FUNDING_HASH, signature_scheme: 'eip712_userop', typed_data: typedData }
            : { hash: FUNDING_HASH },
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

  it('completes the SAME flow on the delegation rail, signing typed data (v2)', async () => {
    // The gap #1187 closes. Nothing in this file used to reach
    // `signX402FundingTypedData`, so a signer build predating it stayed green
    // here while being unusable for every delegation-rail account — which is
    // the default account type.
    stubHavenApi('delegation')

    const havenKeyless = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const hostedHandlers = createHostedHandlers(havenKeyless)
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)

    const x402Expected = await makeX402ExpectedAuth('delegation')

    // The hosted surface must relay the typed data, not just the hash — the
    // account validates the former and the signer refuses to sign bytes the
    // context does not commit to.
    const quote = ok<{
      payload_hash: string
      signature_scheme?: string
      typed_data?: unknown
      x402: { expected: Record<string, unknown> }
    }>(
      // #1272: the byte-relay transport under test here is opt-in now.
      await hostedHandlers.haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        include_signing_payload: true,
      }),
    )

    expect(quote.signature_scheme).toBe('eip712_userop')
    expect(quote.typed_data).toBeDefined()

    const signed = ok<{ signature: string; x402_binding: string }>(
      await signerHandlers.haven_sign({
        payload_hash: FUNDING_HASH,
        typed_data: quote.typed_data,
        x402_expected: x402Expected.snake,
      }),
    )

    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)

    // An EIP-712 signature over the typed data, NOT a raw signature over the
    // 4337 hash — the two are different values and only one is what the
    // account checks.
    const rawOverHash = await privateKeyToAccount(DELEGATE_KEY).signMessage({
      message: { raw: FUNDING_HASH as `0x${string}` },
    })
    expect(signed.signature).not.toBe(rawOverHash)

    // Custody holds on this rail too: the key never reaches hosted traffic.
    expect(JSON.stringify(capturedCalls)).not.toContain(DELEGATE_KEY)
  })

  it('round-trips a redemption-sized payload via typed_data_b64 — the copy-through-safe form (#1255)', async () => {
    // The live #1255 failure: an agent re-emitting the multi-KB typed_data
    // JSON between the hosted quote and the local signer altered it, and the
    // signer's digest check refused. The b64 form crosses as ONE opaque
    // string. This test walks the REAL surfaces end to end with a payload of
    // the size class that actually broke.
    stubHavenApi('delegation', REALISTIC_TYPED_DATA)

    const havenKeyless = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const hostedHandlers = createHostedHandlers(havenKeyless)
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)

    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)

    const quote = ok<{ typed_data?: unknown; typed_data_b64?: string }>(
      // #1272: the b64 round-trip under test is the opt-in transport.
      await hostedHandlers.haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
        include_signing_payload: true,
      }),
    )
    expect(quote.typed_data_b64).toBeDefined()
    // The opaque form decodes to EXACTLY the payload the hosted surface
    // relayed — same bytes, different transport.
    expect(JSON.parse(Buffer.from(quote.typed_data_b64!, 'base64').toString('utf8'))).toEqual(
      quote.typed_data,
    )

    // The signer accepts the b64 form ALONE — no nested-JSON copy anywhere.
    const signed = ok<{ signature: string }>(
      await signerHandlers.haven_sign({
        payload_hash: FUNDING_HASH,
        typed_data_b64: quote.typed_data_b64,
        x402_expected: x402Expected.snake,
      }),
    )
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(JSON.stringify(capturedCalls)).not.toContain(DELEGATE_KEY)
  })

  it('haven_sign_x402 (the fast path) also accepts typed_data_b64 alone (#1255)', async () => {
    stubHavenApi('delegation', REALISTIC_TYPED_DATA)
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)

    const signed = ok<{ signature: string; payment_header: string }>(
      await signerHandlers.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        typed_data_b64: Buffer.from(JSON.stringify(REALISTIC_TYPED_DATA)).toString('base64'),
        x402_expected: x402Expected.snake,
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(signed.payment_header.length).toBeGreaterThan(0)
  })

  it('version skew degrades gracefully in both directions (#1255)', async () => {
    // Old signer + new hosted: a zod v3 object schema WITHOUT typed_data_b64
    // strips the unknown field, leaving typed_data — the pre-#1255 behavior.
    const oldShape = z.object({
      payload_hash: z.string(),
      typed_data: z.record(z.string(), z.unknown()).optional(),
    })
    const parsed = oldShape.parse({
      payload_hash: FUNDING_HASH,
      typed_data: TYPED_DATA,
      typed_data_b64: Buffer.from(JSON.stringify(TYPED_DATA)).toString('base64'),
    })
    expect('typed_data_b64' in parsed).toBe(false)
    expect(parsed.typed_data).toEqual(TYPED_DATA)

    // New signer + old hosted (no typed_data_b64): falls back to typed_data.
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)
    const x402Expected = await makeX402ExpectedAuth('delegation')
    const signed = ok<{ signature: string }>(
      await signerHandlers.haven_sign({
        payload_hash: FUNDING_HASH,
        typed_data: TYPED_DATA,
        x402_expected: x402Expected.snake,
      }),
    )
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)
  })

  it('signs from payment_id ALONE — the byte-free handoff (#1263)', async () => {
    // The durable fix for #1255/#1263: the model relays only payment_id; the
    // signer fetches the exact bytes itself. This walks the real handler with
    // a stubbed Haven sign-context endpoint serving the redemption-sized
    // payload — no typed_data anywhere in the tool call.
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)
    let fetchedUrl = ''
    const signContextFetch = (async (url: unknown, init?: RequestInit) => {
      fetchedUrl = String(url)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_agent_ctx')
      return new Response(
        JSON.stringify({
          payment_id: FUNDING_PAYMENT_ID,
          sign_data: {
            hash: FUNDING_HASH,
            signature_scheme: 'eip712_userop',
            typed_data: REALISTIC_TYPED_DATA,
          },
          x402_expected: x402Expected.snake,
        }),
        { status: 200 },
      )
    }) as typeof fetch

    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: {
        loadIdentity: async () => ({ apiUrl: 'http://haven.test', apiKey: 'sk_agent_ctx' }),
        fetchImpl: signContextFetch,
      },
    })

    const signed = ok<{ signature: string; payment_header: string }>(
      await signerHandlers.haven_sign_x402({
        payment_id: FUNDING_PAYMENT_ID,
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    expect(fetchedUrl).toBe(`http://haven.test/x402/${FUNDING_PAYMENT_ID}/sign-context`)
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(signed.payment_header.length).toBeGreaterThan(0)
  })

  it('a fetched payload still passes the SAME digest check — provenance skips nothing (#1263)', async () => {
    // Serve a typed_data that does NOT match the committed digest: the signer
    // must refuse it exactly as it refuses a mangled tool argument.
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)
    const mangled = {
      ...REALISTIC_TYPED_DATA,
      message: {
        ...(REALISTIC_TYPED_DATA.message as Record<string, unknown>),
        callData: '0x' + 'ab'.repeat(100),
      },
    }
    const signContextFetch = (async () =>
      new Response(
        JSON.stringify({
          payment_id: FUNDING_PAYMENT_ID,
          sign_data: { hash: FUNDING_HASH, signature_scheme: 'eip712_userop', typed_data: mangled },
          x402_expected: x402Expected.snake,
        }),
        { status: 200 },
      )) as typeof fetch
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: {
        loadIdentity: async () => ({ apiUrl: 'http://haven.test', apiKey: 'sk_agent_ctx' }),
        fetchImpl: signContextFetch,
      },
    })
    const payload = await signerHandlers.haven_sign_x402({
      payment_id: FUNDING_PAYMENT_ID,
      payment_required: PAYMENT_REQUIRED,
    })
    expect(payload.success).toBe(false)
    if (!payload.success) expect(payload.message).toContain('does not match the digest')
  })

  it('haven_sign (decomposed path) also signs from payment_id alone (#1263)', async () => {
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)
    const signContextFetch = (async () =>
      new Response(
        JSON.stringify({
          payment_id: FUNDING_PAYMENT_ID,
          sign_data: { hash: FUNDING_HASH, signature_scheme: 'eip712_userop', typed_data: REALISTIC_TYPED_DATA },
          x402_expected: x402Expected.snake,
        }),
        { status: 200 },
      )) as typeof fetch
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: {
        loadIdentity: async () => ({ apiUrl: 'http://haven.test', apiKey: 'sk_agent_ctx' }),
        fetchImpl: signContextFetch,
      },
    })
    const signed = ok<{ signature: string; x402_binding: string }>(
      await signerHandlers.haven_sign({ payment_id: FUNDING_PAYMENT_ID }),
    )
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(signed.x402_binding.length).toBeGreaterThan(0)
  })

  it('a caller-supplied payload_hash that disagrees with the fetch is refused (#1263)', async () => {
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)
    const signContextFetch = (async () =>
      new Response(
        JSON.stringify({
          payment_id: FUNDING_PAYMENT_ID,
          sign_data: { hash: FUNDING_HASH, signature_scheme: 'eip712_userop', typed_data: REALISTIC_TYPED_DATA },
          x402_expected: x402Expected.snake,
        }),
        { status: 200 },
      )) as typeof fetch
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: {
        loadIdentity: async () => ({ apiUrl: 'http://haven.test', apiKey: 'sk_agent_ctx' }),
        fetchImpl: signContextFetch,
      },
    })
    const payload = await signerHandlers.haven_sign({
      payment_id: FUNDING_PAYMENT_ID,
      payload_hash: '0x' + '99'.repeat(32),
    })
    expect(payload.success).toBe(false)
    if (!payload.success) expect(payload.message).toContain('does not match the signing context')
  })

  it('a DIRECT-payment payment_id surfaces the backend refusal with its fallback (#1263)', async () => {
    const signContextFetch = (async () =>
      new Response(
        JSON.stringify({
          error:
            'Not an x402 intent — sign-context serves the x402 signing handoff only. ' +
            'For a direct payment, sign the typed_data_b64 from the haven_pay/haven_send result instead.',
          error_code: 'sign_context_unavailable',
        }),
        { status: 409 },
      )) as typeof fetch
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: {
        loadIdentity: async () => ({ apiUrl: 'http://haven.test', apiKey: 'sk_agent_ctx' }),
        fetchImpl: signContextFetch,
      },
    })
    const payload = await signerHandlers.haven_sign({ payment_id: FUNDING_PAYMENT_ID })
    expect(payload.success).toBe(false)
    if (!payload.success) expect(payload.message).toContain('typed_data_b64')
  })

  it('payment_id without a local identity refuses with the fallback named (#1263)', async () => {
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner, {
      signContext: { loadIdentity: async () => null },
    })
    const payload = await signerHandlers.haven_sign_x402({
      payment_id: FUNDING_PAYMENT_ID,
      payment_required: PAYMENT_REQUIRED,
    })
    expect(payload.success).toBe(false)
    if (!payload.success) {
      expect(payload.message).toContain('identity.json')
      expect(payload.message).toContain('typed_data_b64')
    }
  })

  it('still refuses an altered payload: one flipped field fails the digest check (#1255)', async () => {
    // The digest check is the guard that made the live failure SAFE — the b64
    // transport must not weaken it. Simulate the copy-through corruption the
    // wild produced: one field of the multi-KB payload altered.
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner)
    const x402Expected = await makeX402ExpectedAuth('delegation', REALISTIC_TYPED_DATA)

    const truncated = {
      ...REALISTIC_TYPED_DATA,
      message: {
        ...(REALISTIC_TYPED_DATA.message as Record<string, unknown>),
        // The signature-eliding failure mode: a long hex string cut short.
        callData: '0x' + 'ab'.repeat(100),
      },
    }
    const payload = await signerHandlers.haven_sign({
      payload_hash: FUNDING_HASH,
      typed_data_b64: Buffer.from(JSON.stringify(truncated)).toString('base64'),
      x402_expected: x402Expected.snake,
    })
    expect(payload.success).toBe(false)
    if (!payload.success) {
      expect(payload.message).toContain('does not match the digest')
      expect(payload.message).toContain('typed_data_b64')
    }
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

  it('lets the agent compare hosted-emitted and signer-supported versions pre-payment (#1155)', async () => {
    // The cross-package half of #1155, and the only place both sides are in one
    // process. The hosted server is keyless and must NOT depend on
    // @haven_ai/signer at runtime, so it spells the capability key as a literal;
    // this pins that literal to the signer's exported constant. A rename on
    // either side would otherwise leave the agent looking up a key that no
    // longer exists — a silent downgrade to no detection at all.
    const havenKeyless = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const quote = ok<{
      signer_compatibility: { x402_expected_context_version: number; signer_capability: string }
    }>(
      await createHostedHandlers(havenKeyless).haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
      }),
    )

    expect(quote.signer_compatibility.signer_capability).toBe(SIGNER_CAPABILITY_KEY)
    // Today's traffic is in step: what this backend fixture emits is a version
    // the shipped signer verifies. When that stops being true, the agent sees it
    // at quote time instead of at signing time.
    expect(signerCompatibility().x402_expected_context_versions).toContain(
      quote.signer_compatibility.x402_expected_context_version,
    )
  })

  it('hosted MCP never has a signing path (custody guard)', () => {
    // The hosted client must be constructed without a delegate key.
    // An api-key-only client has no delegate address and no signing path.
    const client = createHostedHavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    expect(client.delegateAddress).toBeUndefined()
  })
})

/**
 * #2291: walk the chain the hosted response actually EMITS, rather than a
 * chain a test author retyped from the prose.
 *
 * The defect this exists to catch: `haven_pay_x402_quote` emitted
 * `next_tool: haven_sign_x402` while the same response's `reason` said to
 * finish with `haven_x402_sign_header`. Those are mutually exclusive —
 * `haven_sign_x402` is a one-shot that builds the header itself and spends its
 * own binding doing so, so the named successor could only refuse. Every
 * surface read plausibly on its own; only following them in order breaks.
 *
 * So this test takes `next_tool` and `next_arguments` from the live response
 * and dispatches on them, with no hardcoded tool name on the happy path. It
 * asserts the emitted chain terminates in a usable merchant header, and — as
 * its control — that the sequence the old guidance named genuinely cannot
 * work, so this is a real constraint and not a tautology.
 */
describe('#2291 — the emitted guidance chain is executable', () => {
  it('walks next_tool/next_arguments from the quote to a usable merchant header', async () => {
    const havenKeyless = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const hostedHandlers = createHostedHandlers(havenKeyless)
    const edgeSigner = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const signerHandlers = createSignerHandlers(edgeSigner) as unknown as Record<
      string,
      (args: Record<string, unknown>) => Promise<ToolPayload>
    >

    const quote = ok<{
      payment_id: string
      next_tool: string
      next_tool_name: string
      next_arguments: Record<string, unknown>
      reason: string
    }>(await hostedHandlers.haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    // Dispatch on what the response SAID, not on a name written here.
    const handler = signerHandlers[quote.next_tool_name]
    expect(handler, `hosted named a signer tool that does not exist: ${quote.next_tool}`).toBeTypeOf(
      'function',
    )

    // What the response tells the agent to pass, asserted as emitted.
    expect(quote.next_arguments).toEqual({ payment_id: quote.payment_id })

    // That byte-free form has the signer FETCH its own context, which needs a
    // provisioned agent identity on disk — out of scope here and covered by the
    // sign-context tests. Executed through the documented fallback transport
    // instead: same tool, same contract, context handed over rather than
    // fetched. The tool under test is still the one the response NAMED; only
    // how its context arrives differs, and that is not what this test asserts.
    const expected = await makeX402ExpectedAuth()
    const signed = ok<{ signature: string; x402_binding: string; payment_header?: string }>(
      await handler({
        payload_hash: FUNDING_HASH,
        x402_expected: expected.snake,
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/)

    // The terminal deliverable of this path is a merchant header. Under the
    // one-shot contract it arrives INLINE — the agent needs no further signer
    // call, which is exactly what the corrected guidance says.
    expect(
      signed.payment_header,
      'the emitted chain must terminate in a merchant header the agent can retry with',
    ).toBeTruthy()
    expect(signed.payment_header!.length).toBeGreaterThan(0)

    // CONTROL: the sequence the old guidance named. If this ever SUCCEEDS, the
    // one-shot has stopped spending its binding and the assertion above stops
    // proving anything — so the control is what keeps this test honest.
    const oldGuidanceStep = await signerHandlers.haven_x402_sign_header({
      payment_required: PAYMENT_REQUIRED,
      x402_binding: signed.x402_binding,
    })
    expect(oldGuidanceStep.success).toBe(false)
    expect(JSON.stringify(oldGuidanceStep)).toContain('already used')
  })
})
