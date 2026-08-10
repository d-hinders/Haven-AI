/**
 * The x402 expected-context **wire contract**, end to end across four packages
 * (#1154), and the v1/v2 binding matrix (#1138) that rides on it.
 *
 * ## What drifts, and why the failure is so misleading when it does
 *
 * Haven's backend signs a canonical message describing what it authorised. The
 * edge signer independently *reconstructs* that message from the context it
 * receives and refuses to sign unless the two match byte for byte. Nothing
 * transmits the message's inputs as a single blob — they are re-derived at every
 * hop, and there are four:
 *
 *   1. `backend/src/modules/x402/{delegation,legacy}-authorize.ts` builds an
 *      `X402ExpectedContext` and signs `buildX402ExpectedMessage(context)`.
 *   2. `sdk/src/client.ts` `createX402Intent` maps the HTTP response into an
 *      intent — re-deriving `merchantTo`, `amountAtomic`, `asset`, `network`,
 *      `resourceUrl` and the typed-data digest from its OWN view of the world.
 *   3. `mcp-server/src/tools.ts` `buildX402SigningContext` flattens that intent
 *      into the snake_case `x402.expected` object that crosses to the signer.
 *   4. `signer/src/tools.ts` `toExpectedX402` maps it back to camelCase, and
 *      `core.ts` `assertExpectedBinding` rebuilds the message and compares.
 *
 * Rename, drop, or re-case a field at ANY of those hops and the reconstruction
 * diverges. The runtime symptom is
 * `x402 expected context authentication message is invalid.` — which reads like
 * a credential or clock problem and sends a debugging session after the wrong
 * thing entirely. #1154 asked for a test that turns that whole class into a CI
 * failure, and this is it: cheap, and it catches every member of the class.
 *
 * ## Everything here is the real implementation
 *
 * The backend producer is imported directly (`signX402ExpectedContext`), the
 * SDK's `HavenClient` runs against a stubbed HTTP layer, the hosted tool handler
 * is the shipped one, and the signer is the published `@haven_ai/signer`. The
 * ONLY thing this file writes itself is the backend's HTTP response body — the
 * one hop with no importable function — and it is written to match
 * `delegation-authorize.ts` / `legacy-authorize.ts` field for field.
 *
 * The existing `hosted-signer-integration.test.ts` covers the same flow at v1
 * only, with a hand-built context. This file is the v2 half and the byte-level
 * contract.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { buildX402ExpectedMessage, type X402PaymentRequired } from '@haven_ai/sdk'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'
import {
  createEdgeSigner,
  createToolHandlers as createSignerHandlers,
  toolSchemas as signerToolSchemas,
} from '@haven_ai/signer'
import { z } from 'zod/v3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createToolHandlers as createHostedHandlers, type ToolPayload } from './tools.js'
import { createHostedHavenClient } from './server.js'

/**
 * The REAL backend producer, loaded at runtime.
 *
 * `backend` is a private, unpublished workspace package with no export map, so
 * there is no package specifier to import. A relative import would work at
 * runtime but puts a file outside `rootDir` into this package's TS program
 * (TS6059) — so the specifier is computed, which keeps `tsc` out of it while
 * vitest still loads and executes the genuine module. Reproducing its twenty
 * lines here instead would test this file's copy of the contract, not the
 * contract.
 */
const BACKEND_PRODUCER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../backend/src/infra/chain/x402-binding-signer.ts',
)

type SignedExpectedAuth = { version: 1 | 2; message: string; signature: string; signer: string }
type BackendProducer = (context: Record<string, unknown>) => Promise<SignedExpectedAuth>

let signX402ExpectedContext: BackendProducer


// Well-known Hardhat keys — never used for real funds, and identical to the
// ones the neighbouring integration test uses.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const DELEGATE_ADDR = privateKeyToAccount(DELEGATE_KEY).address

const MERCHANT = '0x000000000000000000000000000000000000dEaD'
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Base Sepolia USDC
const RESOURCE = 'https://merchant.test/mcp'
const AMOUNT = '1000'
const NETWORK = 'base-sepolia'
const PAYMENT_ID = 'pay_wire_contract'
const FUNDING_HASH = '0x' + 'cd'.repeat(32)
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'

const PAYMENT_REQUIRED: X402PaymentRequired = {
  x402Version: 2,
  resource: { url: RESOURCE, description: 'paid tool' },
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK,
      amount: AMOUNT,
      asset: ASSET,
      payTo: MERCHANT,
      maxTimeoutSeconds: 60,
    },
  ],
} as unknown as X402PaymentRequired

/**
 * The EIP-712 payload a delegation-rail account validates. Shape only — the
 * digest is what the contract turns on, and it is re-derived from these exact
 * bytes at three independent points.
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
} as const

const TYPED_DATA_DIGEST = hashTypedData(TYPED_DATA as Parameters<typeof hashTypedData>[0])

/**
 * The backend's `POST /x402` 201 body, written to mirror
 * `delegation-authorize.ts` (v2) and `legacy-authorize.ts` (v1) field for field.
 *
 * The `x402_expected_auth` value is produced by the REAL backend producer, with
 * the REAL context those routes build — including the lower-casing they apply to
 * `merchantTo`, which is the kind of detail a hand-written fixture drops.
 */
async function backendAuthorizeBody(rail: 'delegation' | 'legacy') {
  const typedDataHash = rail === 'delegation' ? TYPED_DATA_DIGEST : undefined
  const expectedAuth = await signX402ExpectedContext({
    paymentId: PAYMENT_ID,
    payloadHash: FUNDING_HASH,
    resourceUrl: RESOURCE,
    merchantTo: MERCHANT.toLowerCase(),
    amount: AMOUNT,
    asset: ASSET,
    network: NETWORK,
    expiresAt: EXPIRES_AT,
    ...(typedDataHash ? { typedDataHash } : {}),
  })
  return {
    payment_id: PAYMENT_ID,
    status: 'pending_signature',
    expires_at: EXPIRES_AT,
    chain_id: 84532,
    safe_address: '0x' + 'a1'.repeat(20),
    payer: '0x' + 'a1'.repeat(20),
    token: 'USDC',
    amount: '0.001',
    to: DELEGATE_ADDR.toLowerCase(),
    merchant_to: MERCHANT.toLowerCase(),
    resource_url: RESOURCE,
    x402_expected_auth: expectedAuth,
    sign_data:
      rail === 'delegation'
        ? { hash: FUNDING_HASH, signature_scheme: 'eip712_userop', typed_data: TYPED_DATA }
        : { hash: FUNDING_HASH },
  }
}

function jsonResponse(status: number, body: unknown) {
  const headers = new Headers({ 'content-type': 'application/json' })
  const shape = { ok: status >= 200 && status < 300, status, headers, json: async () => body }
  return { ...shape, clone: () => shape }
}

/** Stub only the HTTP layer; every mapping between here and the signer is real. */
function stubHavenApi(body: unknown) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname
    const method = (init.method ?? 'GET').toUpperCase()
    if (method === 'GET' && path === '/machine-payments/agent') {
      return jsonResponse(200, { id: 'agt_1', status: 'active', delegate_address: DELEGATE_ADDR, chain_id: 84532 })
    }
    if (method === 'POST' && path === '/x402') return jsonResponse(201, body)
    return jsonResponse(404, { error: `No stub for ${method} ${path}` })
  })
}

function ok<T>(result: ToolPayload): T {
  if (!result.success) throw new Error(`expected success, got [${result.code}] ${result.message}`)
  return (result as { success: true; data: T }).data
}

interface WireExpected {
  payment_id: string
  payload_hash: string
  resource_url: string
  merchant_to: string
  amount: string
  asset: string
  network: string
  expires_at: string
  typed_data_hash?: string
  auth: { version: number; message: string; signature: string; signer: string }
}
interface WireQuote {
  payload_hash: string
  signature_scheme?: string
  typed_data?: Record<string, unknown>
  x402: { expected: WireExpected }
}

/**
 * Drive the real chain: backend body → SDK intent → hosted signing context.
 * Returns the exact wire object the hosted MCP hands a local signer.
 */
async function hostedQuote(rail: 'delegation' | 'legacy'): Promise<WireQuote> {
  stubHavenApi(await backendAuthorizeBody(rail))
  const haven = createHostedHavenClient({ apiKey: 'sk_agent_test', baseUrl: 'https://haven.test' })
  const hosted = createHostedHandlers(haven)
  return ok<WireQuote>(
    // #1272: this file proves the agent-relayed byte transport, which is now
    // opt-in — the compact default is proven in tools.test.ts.
    await hosted.haven_pay_x402_quote({
      payment_required: PAYMENT_REQUIRED as unknown as Record<string, unknown>,
      include_signing_payload: true,
    }),
  )
}

/**
 * The snake→camel mapping the signer performs internally (`toExpectedX402`,
 * module-private). Mirrored here ONLY so the byte comparison can be made
 * explicit; the behavioural half below — the real signer accepting the same wire
 * object — is what actually pins the signer's own mapping.
 */
function toCamel(wire: WireExpected) {
  return {
    paymentId: wire.payment_id,
    payloadHash: wire.payload_hash,
    typedDataHash: wire.typed_data_hash,
    resourceUrl: wire.resource_url,
    merchantTo: wire.merchant_to,
    amount: wire.amount,
    asset: wire.asset,
    network: wire.network,
    expiresAt: wire.expires_at,
    auth: wire.auth,
  }
}

function localSigner() {
  return createSignerHandlers(createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER }))
}

beforeAll(async () => {
  const mod = (await import(BACKEND_PRODUCER)) as { signX402ExpectedContext: BackendProducer }
  signX402ExpectedContext = mod.signX402ExpectedContext
})

beforeEach(() => {
  process.env.X402_BINDING_PRIVATE_KEY = BINDING_KEY
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.X402_BINDING_PRIVATE_KEY
})

describe('cross-package wire contract: producer and reconstruction are byte-identical (#1154)', () => {
  it.each([
    ['v1 (legacy rail)', 'legacy' as const, 1],
    ['v2 (delegation rail)', 'delegation' as const, 2],
  ])('%s — the message survives all four hops unchanged', async (_name, rail, version) => {
    const quote = await hostedQuote(rail)
    const wire = quote.x402.expected

    // The producer's own bytes, signed by the backend, versus the bytes the
    // consumer rebuilds from what actually reached it. Byte equality here is
    // the whole contract: `assertExpectedBinding` compares exactly these two.
    expect(buildX402ExpectedMessage(toCamel(wire))).toBe(wire.auth.message)

    // The version is DERIVED from the context on both sides, never chosen.
    expect(wire.auth.version).toBe(version)
    expect(wire.auth.message.startsWith(`Haven x402 expected context v${version}\n`)).toBe(true)
    expect(wire.auth.signer.toLowerCase()).toBe(BINDING_SIGNER.toLowerCase())
  })

  it.each([
    ['v1 (legacy rail)', 'legacy' as const],
    ['v2 (delegation rail)', 'delegation' as const],
  ])('%s — the real signer accepts it and signs', async (_name, rail) => {
    // The behavioural half: this exercises the signer's OWN reconstruction
    // (`toExpectedX402` + `assertExpectedBinding`), which the explicit byte
    // comparison above cannot reach because both are module-private.
    const quote = await hostedQuote(rail)
    const result = await localSigner().haven_sign_x402({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      ...(quote.typed_data ? { typed_data: quote.typed_data } : {}),
    })
    expect(result.success).toBe(true)
    expect(ok<{ signature: string; payment_header: string }>(result).signature).toMatch(/^0x[0-9a-f]{130}$/i)
  })

  it('the v2 context commits to the digest of the typed data actually delivered', async () => {
    // Three independent derivations of one digest — backend `typedDataDigest`,
    // SDK `x402TypedDataDigest`, signer `hashTypedData` at signing time. If any
    // two disagree the payment dies at the last one, after the intent is
    // claimed.
    const quote = await hostedQuote('delegation')
    expect(quote.x402.expected.typed_data_hash).toBe(TYPED_DATA_DIGEST)
    expect(hashTypedData(quote.typed_data as Parameters<typeof hashTypedData>[0])).toBe(TYPED_DATA_DIGEST)
  })
})

describe('the wire contract fails closed when a hop drifts (#1154)', () => {
  // Each case is a field being renamed, dropped, or re-cased somewhere in the
  // chain. If the assertions above ever stopped being load-bearing, these would
  // start passing silently — so they assert the REFUSAL, not just inequality.
  it.each([
    ['a dropped expires_at', (w: WireExpected) => delete (w as Partial<WireExpected>).expires_at, /Required|invalid/i],
    ['a re-cased merchant_to', (w: WireExpected) => (w.merchant_to = MERCHANT.toUpperCase()), null],
    ['a changed amount', (w: WireExpected) => (w.amount = '999'), /authentication message is invalid/],
    ['a changed network', (w: WireExpected) => (w.network = 'base'), /authentication message is invalid/],
    ['a changed resource_url', (w: WireExpected) => (w.resource_url = 'https://other.test/mcp'), /authentication message is invalid/],
  ])('refuses %s', async (_name, mutate, pattern) => {
    const quote = await hostedQuote('delegation')
    mutate(quote.x402.expected)
    const result = await localSigner().haven_sign_x402({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      typed_data: quote.typed_data,
    })
    if (pattern === null) {
      // Address casing is normalised by the message builder on BOTH sides, so a
      // re-cased address is contractually harmless. Pinned so a future change
      // that made it fatal shows up as a deliberate decision.
      expect(result.success).toBe(true)
      return
    }
    expect(result.success).toBe(false)
    expect((result as { message: string }).message).toMatch(pattern)
  })
})

describe('v1/v2 binding matrix (#1138)', () => {
  it('legacy-rail (v1) context → the raw hash is signed, and it succeeds', async () => {
    const quote = await hostedQuote('legacy')
    expect(quote.x402.expected.typed_data_hash).toBeUndefined()
    // No typed_data on the wire at all — the hosted server only emits it when
    // the backend declared a signature scheme.
    expect(quote.typed_data).toBeUndefined()

    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const { signature } = signer.signX402FundingHash(quote.payload_hash, toCamel(quote.x402.expected))
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i)
  })

  it('delegation-rail (v2) context → the typed data is signed, and it succeeds', async () => {
    const quote = await hostedQuote('delegation')
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const { signature } = await signer.signX402FundingTypedData(
      quote.typed_data as never,
      toCamel(quote.x402.expected),
    )
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i)
  })

  it('v2 context + an attempt to RAW-sign the hash → REFUSED', async () => {
    // The #1138 downgrade. A raw ECDSA signature over the bare 4337 hash is not
    // what the account validates, so it would be rejected on-chain AFTER the
    // intent was claimed — which is why this must fail here, loudly, rather
    // than produce a signature nobody can use.
    const quote = await hostedQuote('delegation')
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    expect(() => signer.signX402FundingHash(quote.payload_hash, toCamel(quote.x402.expected))).toThrow(
      /must not be\s+raw-signed/,
    )
  })

  it('v1 context + an attempt to sign typed data → REFUSED', async () => {
    // The other half of the downgrade, and just as necessary: without a
    // typed-data commitment Haven's declaration covers only a hash that is NOT
    // what would be signed, so the signer would be endorsing a payload it
    // cannot check.
    const quote = await hostedQuote('legacy')
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    await expect(
      signer.signX402FundingTypedData(TYPED_DATA as never, toCamel(quote.x402.expected)),
    ).rejects.toThrow(/does not commit to it/)
  })

  it('typed data whose digest ≠ the committed one → REFUSED', async () => {
    // The payload was altered in transit (or Haven declared a different one).
    // The signer re-derives the digest from the bytes it is about to sign, so a
    // swapped payload cannot ride a valid binding.
    const quote = await hostedQuote('delegation')
    const tampered = { ...TYPED_DATA, message: { ...TYPED_DATA.message, nonce: '8' } }
    const result = await localSigner().haven_sign_x402({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      typed_data: tampered,
    })
    expect(result.success).toBe(false)
    expect((result as { message: string }).message).toMatch(/does not match the digest Haven committed to/)
  })

  it('a v2 context whose auth.version was tampered to 1 → REFUSED', async () => {
    // The version is derived from the context's CONTENTS on both sides, so a
    // rewritten version cannot select a weaker rule set — the recomputed
    // message simply stops matching.
    const quote = await hostedQuote('delegation')
    quote.x402.expected.auth.version = 1
    const result = await localSigner().haven_sign_x402({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      typed_data: quote.typed_data,
    })
    expect(result.success).toBe(false)
    expect((result as { message: string }).message).toMatch(/authentication message is invalid/)
  })
})

describe('the producer this file loads is still the real one', () => {
  // The dynamic specifier above buys `tsc` compatibility at the cost of static
  // checking, so the premise is pinned here instead: a moved file already fails
  // loudly in beforeAll, and these two assertions catch the quieter case where
  // the file survives but stops being the thing under test. Same three-way-drift
  // discipline as skip-marker.test.ts.
  const source = readFileSync(BACKEND_PRODUCER, 'utf8')

  it('signs the SHARED message builder\'s output, not a local one', () => {
    expect(source).toContain('buildX402ExpectedMessage')
    expect(source).toContain('signMessage(message)')
  })

  it('derives the binding version from the context, never accepts one', () => {
    // Announcing a version the message does not match is precisely the
    // downgrade the signer rejects.
    expect(source).toMatch(/context\.typedDataHash \? 2 : 1/)
  })
})

describe('the MCP tool-schema boundary (#1143)', () => {
  // #1154 flags this explicitly: an in-process EdgeSigner call skips the schema
  // where the #1143 skew surfaced as a Zod rejection. So the schema is pinned
  // separately, against the REAL hosted quote rather than a fixture.
  it.each([
    ['v1', 'legacy' as const],
    ['v2', 'delegation' as const],
  ])('accepts the real %s hosted quote shape verbatim', async (_name, rail) => {
    const quote = await hostedQuote(rail)
    const parsed = z.object(signerToolSchemas.haven_sign_x402).safeParse({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      ...(quote.typed_data ? { typed_data: quote.typed_data } : {}),
    })
    expect(parsed.success).toBe(true)
  })

  it('keeps auth.version OPEN so a future bump reaches the signer, not Zod', async () => {
    // The #1143 lesson: a literal version here rejected the payment with
    // "Invalid literal value, expected 1 at x402_expected.auth.version" — a
    // message naming neither the cause nor the fix, and written by nobody at
    // Haven. The semantic refusal must own that error.
    const quote = await hostedQuote('delegation')
    quote.x402.expected.auth.version = 3
    expect(
      z.object(signerToolSchemas.haven_sign_x402).safeParse({
        payload_hash: quote.payload_hash,
        x402_expected: quote.x402.expected,
        payment_required: PAYMENT_REQUIRED,
        typed_data: quote.typed_data,
      }).success,
    ).toBe(true)

    const result = await localSigner().haven_sign_x402({
      payload_hash: quote.payload_hash,
      x402_expected: quote.x402.expected,
      payment_required: PAYMENT_REQUIRED,
      typed_data: quote.typed_data,
    })
    expect(result.success).toBe(false)
    expect((result as { code: string }).code).not.toBe('INVALID_INPUT')
    expect((result as { message: string }).message).toMatch(/out of date|Unsupported/)
  })
})
