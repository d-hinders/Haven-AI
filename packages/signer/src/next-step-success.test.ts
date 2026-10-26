/**
 * #4449 — the SUCCESS-path counterpart of `next-step-characterization.test.ts`.
 *
 * #3103 covered the signer's refusal decision sites only; the six success
 * sites returned no `next_tool*` field and no `next_tool_omitted_reason`, so
 * `CLAUDE.md`'s "every MCP payment-flow response names its next tool" was
 * false for them and `lint:next-steps` could not see them (its numerator is
 * emission blocks that carry a `next_action` decision, and a success result
 * carries none). This walk is therefore their ONLY guard.
 *
 * Keyed per fixture like that file's `STEP` table: each site's exact
 * `next_tool` family, either a tool + arguments or the literal reason string.
 * The walk also refuses a reason matching the SDK builder's silent fallback
 * (`packages/sdk/src/next-step.ts`): a misspelled or unregistered target would
 * otherwise pass as "a reason".
 *
 * Mutation proofs (recorded, not committed):
 *  1. Delete the step from one success site (e.g. the `haven_sign_siwx`
 *     return) → that fixture's `step` assertion goes red.
 *  2. Misspell one argument key in a named handoff (`payment_id` →
 *     `paymentId` in the direct-payment site) → the registry walk's strict
 *     parse goes red, and the `step` assertion too.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { addressFromKey, buildSweepAuthorizationMessage, buildX402ExpectedMessage, deriveDelegateAccountAddress } from '@haven_ai/sdk'
import { buildBoundDirectUserOp, buildFundingLegUserOp } from '@haven_ai/sdk/test-support'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolPayload } from './tools.js'
import { SIGNER_HOSTED_HANDOFF_SHAPES } from './next-step.js'
import { SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS } from './sign-context.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = addressFromKey(TEST_KEY) as `0x${string}`
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE)
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const IDENTITY = { apiKey: 'test-agent-key', apiUrl: 'https://haven.test' }

const RESOURCE_URL = 'https://merchant.test/paid'
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'

const FUNDING_QUOTE = {
  paymentId: 'pay_x402_funding',
  resourceUrl: RESOURCE_URL,
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '1000000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
  network: 'base',
  expiresAt: EXPIRES_AT,
}

// The settlement-delegation fixture's own payee, amount, token and chain.
const CHILD_QUOTE = {
  paymentId: 'pay_x402_child',
  resourceUrl: RESOURCE_URL,
  merchantTo: '0x3333333333333333333333333333333333333333',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
  network: 'eip155:84532',
  expiresAt: EXPIRES_AT,
}

/** A valid v3 Haven binding over `quote`, signed by the configured binding signer. */
async function bind(quote: typeof FUNDING_QUOTE, typedData: unknown, payloadHash: string) {
  const context = {
    ...quote,
    payloadHash,
    typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    payerDelegate: DELEGATE.toLowerCase(),
    payerAgentId: 'agent_4449',
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: { version: 3 as const, message, signature: await account.signMessage({ message }), signer: account.address },
  }
}

/** The snake_case `x402_expected` wire shape the sign-context fetch carries. */
function wire(expected: Awaited<ReturnType<typeof bind>>) {
  return {
    payment_id: expected.paymentId,
    payload_hash: expected.payloadHash,
    resource_url: expected.resourceUrl,
    merchant_to: expected.merchantTo,
    amount: expected.amount,
    asset: expected.asset,
    network: expected.network,
    expires_at: expected.expiresAt,
    typed_data_hash: expected.typedDataHash,
    payer_delegate: expected.payerDelegate,
    payer_agent_id: expected.payerAgentId,
    auth: expected.auth,
  }
}

/** A merchant 402 whose single EIP-3009 option matches `quote` exactly. */
function paymentRequiredFor(quote: typeof FUNDING_QUOTE) {
  return {
    x402Version: 2,
    resource: { url: quote.resourceUrl, description: 'paid data' },
    accepts: [
      {
        scheme: 'exact',
        network: quote.network,
        amount: quote.amount,
        asset: quote.asset,
        payTo: quote.merchantTo,
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  }
}

function signer() {
  return createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER, agentId: 'agent_4449' })
}

function fundingLeg() {
  return buildFundingLegUserOp({
    delegate: DELEGATE,
    asset: FUNDING_QUOTE.asset as `0x${string}`,
    amount: FUNDING_QUOTE.amount,
    chainId: 8453,
  })
}

function ownChild() {
  const td = JSON.parse(
    JSON.stringify(require('../../sdk/src/__fixtures__/settlement-delegation-payload.json')),
  )
  td.message.delegator = OWN_ACCOUNT
  return td
}
const CHILD_PAYLOAD_HASH = `0x${'ab'.repeat(32)}`

/** The child fixture's expiry is a fixed timestamp; the verifier reads Date.now(). */
const inWindow = <T>(fn: () => Promise<T>) => {
  const real = Date.now
  Date.now = () => (0x6a80709b - 60) * 1000
  return fn().finally(() => {
    Date.now = real
  })
}

/** A handler set whose sign-context fetch serves `body` for any payment_id. */
function handlersWithContext(body: Record<string, unknown>) {
  return createToolHandlers(signer(), {
    signContext: {
      loadIdentity: async () => IDENTITY,
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    },
  })
}

/** A handler set whose x402 fetch refuses 409 and whose direct fetch serves `body`. */
function handlersWithDirectContext(body: Record<string, unknown>) {
  return createToolHandlers(signer(), {
    signContext: {
      loadIdentity: async () => IDENTITY,
      fetchImpl: (async (url: unknown) => {
        const path = String(url)
        if (path.includes('/x402/')) {
          return new Response(
            JSON.stringify({ error: 'not an x402 payment', error_code: 'sign_context_unavailable' }),
            { status: 409 },
          )
        }
        if (path.includes('/payments/')) return new Response(JSON.stringify(body), { status: 200 })
        throw new Error(`unexpected fetch: ${path}`)
      }) as typeof fetch,
    },
  })
}

function ok(payload: ToolPayload): Record<string, unknown> {
  if (!payload.success) throw new Error(`expected success, got failure: ${JSON.stringify(payload)}`)
  return payload.data as Record<string, unknown>
}

// ── the literal reasons, pinned whole (never compared against the module's own
//    exported constant: that would compare a mutated string with itself) ──────

const X402_CONTEXT_REASON =
  'the signer cannot tell an MCP merchant from a plain-HTTP one, or a fresh signature from a funded-retry resume: ' +
  'on an MCP merchant call haven_settle_mcp_tool with { payment_id, signature } — add payment_header on EIP-3009 only; ' +
  "on a plain-HTTP merchant call haven_submit with { payment_id, signature } (settlement_scheme 'erc7710' for a " +
  'settlement child, which returns the payment_header) and then retry the merchant yourself; a settlement child’s ' +
  'returned x402_binding is already retired and builds no header'

const HEADER_REASON =
  'the signer cannot tell an MCP merchant from a plain-HTTP one: for a paid MCP tool call haven_complete_mcp_tool ' +
  'with { payment_id, payment_header } once haven_submit has confirmed funding; for a plain-HTTP merchant retry the ' +
  'merchant URL yourself with payment_header in every header named in retry_headers, then report the answer with ' +
  'haven_report_x402_outcome'

const ONE_SHOT_REASON =
  'the signer cannot tell an MCP merchant from a plain-HTTP one: for a paid MCP tool call haven_settle_mcp_tool ' +
  'with { payment_id, signature, payment_header }; for a plain-HTTP merchant relay signature with haven_submit, then ' +
  'retry the merchant URL yourself with payment_header in every header named in retry_headers and report the answer ' +
  'with haven_report_x402_outcome'

const DIRECT_NO_PAYMENT_ID_REASON =
  'this signature was built from caller-supplied typed_data, so the signer holds no payment_id to name: call ' +
  'haven_submit with the payment_id from the pay result and this signature'

const SIWX_REASON =
  'retry the merchant request with the SIGN-IN-WITH-X header this result carries (sign_in_with_x_header) — no hosted ' +
  'Haven tool follows a sign-in'

// ── fixtures ────────────────────────────────────────────────────────────────

type Fixture = {
  site: string
  run: () => Promise<Record<string, unknown>>
  /** The exact `next_tool` family this site must emit, given its own result. */
  step: (out: Record<string, unknown>) => Record<string, unknown>
  /** The declared variant the emitted arguments must parse under, when a tool is named. */
  shape?: keyof typeof SIGNER_HOSTED_HANDOFF_SHAPES
}

const reasonStep = (reason: string) => () => ({ next_tool_omitted_reason: reason })

const FIXTURES: Fixture[] = [
  {
    site: 'haven_sign direct payment, { payment_id } → hosted haven_submit',
    shape: 'haven_submit#payment',
    run: async () => {
      const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: DELEGATE })
      return ok(
        await handlersWithDirectContext({
          payment_id: 'pay_direct',
          status: 'pending_signature',
          direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
          sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData },
        }).haven_sign({ payment_id: 'pay_direct' }),
      )
    },
    step: (out) => ({
      next_tool: 'mcp__haven__haven_submit',
      next_tool_server: 'haven',
      next_tool_name: 'haven_submit',
      next_tool_server_role: 'hosted',
      next_arguments: { payment_id: 'pay_direct', signature: out.signature },
    }),
  },
  {
    site: 'haven_sign direct payment, caller-supplied typed_data → reason (no payment_id to name)',
    run: async () => {
      const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: DELEGATE })
      return ok(await createToolHandlers(signer()).haven_sign({ payload_hash: payloadHash, typed_data: typedData }))
    },
    step: reasonStep(DIRECT_NO_PAYMENT_ID_REASON),
  },
  {
    site: 'haven_sign x402 funding leg, { payment_id } → reason naming both settle routes',
    run: async () => {
      const funding = fundingLeg()
      const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
      return ok(
        await handlersWithContext({
          payment_id: expected.paymentId,
          sign_data: { hash: expected.payloadHash, typed_data: funding.typedData },
          x402_expected: wire(expected),
          payment_required: paymentRequiredFor(FUNDING_QUOTE),
        }).haven_sign({ payment_id: expected.paymentId }),
      )
    },
    step: reasonStep(X402_CONTEXT_REASON),
  },
  {
    site: 'haven_sign x402 funding leg, caller-supplied x402_expected → the same reason',
    run: async () => {
      const funding = fundingLeg()
      const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
      return ok(
        await createToolHandlers(signer()).haven_sign({
          payload_hash: funding.payloadHash,
          typed_data: funding.typedData,
          x402_expected: wire(expected),
        }),
      )
    },
    step: reasonStep(X402_CONTEXT_REASON),
  },
  {
    site: 'haven_sign x402 erc7710 settlement child, { payment_id } → the same reason (binding already retired)',
    run: async () => {
      const td = ownChild()
      const expected = await bind(CHILD_QUOTE, td, CHILD_PAYLOAD_HASH)
      return inWindow(async () =>
        ok(
          await handlersWithContext({
            payment_id: expected.paymentId,
            sign_data: { hash: expected.payloadHash, typed_data: td },
            x402_expected: wire(expected),
            payment_required: paymentRequiredFor(CHILD_QUOTE),
          }).haven_sign({ payment_id: expected.paymentId }),
        ),
      )
    },
    step: reasonStep(X402_CONTEXT_REASON),
  },
  {
    site: 'haven_x402_sign_header → reason naming the MCP completion and the plain-HTTP retry',
    run: async () => {
      const funding = fundingLeg()
      const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
      const handlers = createToolHandlers(signer())
      const signed = ok(
        await handlers.haven_sign({
          payload_hash: funding.payloadHash,
          typed_data: funding.typedData,
          x402_expected: wire(expected),
        }),
      )
      return ok(
        await handlers.haven_x402_sign_header({
          payment_required: paymentRequiredFor(FUNDING_QUOTE),
          x402_binding: signed.x402_binding,
        } as never),
      )
    },
    step: reasonStep(HEADER_REASON),
  },
  {
    site: 'haven_sign_x402, { payment_id } → reason naming both settle routes',
    run: async () => {
      const funding = fundingLeg()
      const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
      return ok(
        await handlersWithContext({
          payment_id: expected.paymentId,
          sign_data: { hash: expected.payloadHash, typed_data: funding.typedData },
          x402_expected: wire(expected),
          payment_required: paymentRequiredFor(FUNDING_QUOTE),
        }).haven_sign_x402({ payment_id: expected.paymentId }),
      )
    },
    step: reasonStep(ONE_SHOT_REASON),
  },
  {
    site: 'haven_sign_x402, caller-supplied x402_expected → the same reason',
    run: async () => {
      const funding = fundingLeg()
      const expected = await bind(FUNDING_QUOTE, funding.typedData, funding.payloadHash)
      return ok(
        await createToolHandlers(signer()).haven_sign_x402({
          payload_hash: funding.payloadHash,
          typed_data: funding.typedData,
          x402_expected: wire(expected),
          payment_required: paymentRequiredFor(FUNDING_QUOTE),
        } as never),
      )
    },
    step: reasonStep(ONE_SHOT_REASON),
  },
  {
    site: 'haven_sign_sweep_delegate → hosted haven_sweep_delegate phase 2',
    shape: 'haven_sweep_delegate#sweep',
    run: async () => {
      const authorization = {
        from: DELEGATE,
        to: '0x000000000000000000000000000000000000dEaD',
        value: '40000',
        validAfter: '0',
        validBefore: '2000000000',
        nonce: `0x${'ab'.repeat(32)}`,
        token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        chainId: 8453,
      }
      const message = buildSweepAuthorizationMessage(authorization)
      const expectedAuth = {
        version: 1 as const,
        message,
        signature: await privateKeyToAccount(BINDING_KEY).signMessage({ message }),
        signer: BINDING_SIGNER,
      }
      return ok(
        await createToolHandlers(signer()).haven_sign_sweep_delegate({
          authorization,
          expected_auth: expectedAuth,
        } as never),
      )
    },
    step: (out) => ({
      next_tool: 'mcp__haven__haven_sweep_delegate',
      next_tool_server: 'haven',
      next_tool_name: 'haven_sweep_delegate',
      next_tool_server_role: 'hosted',
      next_arguments: {
        authorization: {
          from: DELEGATE,
          to: '0x000000000000000000000000000000000000dEaD',
          value: '40000',
          validAfter: '0',
          validBefore: '2000000000',
          nonce: `0x${'ab'.repeat(32)}`,
          token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          chainId: 8453,
        },
        signature: out.signature,
      },
    }),
  },
  {
    site: 'haven_sign_siwx → reason (no hosted tool follows a sign-in)',
    run: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-siwx-success-'))
      try {
        const now = Date.now()
        const challenge = {
          info: {
            domain: 'api.bitrefill.com',
            uri: 'https://api.bitrefill.com/x402/connect',
            version: '1',
            nonce: '9f2c1e7a4b8d3f06a5c2e19d7b4f803c',
            issuedAt: new Date(now - 60_000).toISOString(),
            expirationTime: new Date(now + 120_000).toISOString(),
            statement: 'Sign in with your Ethereum account to access Bitrefill x402 APIs',
            resources: ['https://api.bitrefill.com/x402/resource'],
          },
          supportedChains: [{ chainId: 'eip155:8453', type: 'eip191' }],
          schema: { type: 'object' },
        }
        const s = signer()
        return ok(
          await createToolHandlers(s, {
            audit: { auditPath: join(dir, 'audit.jsonl'), delegateAddress: s.delegateAddress, chainId: 8453 },
          }).haven_sign_siwx({
            url: 'https://api.bitrefill.com/x402/connect',
            challenge,
          } as never),
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    step: reasonStep(SIWX_REASON),
  },
]

const STEP_KEYS = [
  'next_tool',
  'next_tool_server',
  'next_tool_name',
  'next_tool_server_role',
  'next_arguments',
  'next_tool_omitted_reason',
] as const

function stepOf(out: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(STEP_KEYS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]]))
}

describe('signer success wire — every success site names its exact next step (#4449)', () => {
  it('registry walk: every named handoff parses under its declared strict shape, and no reason is the builder fallback', async () => {
    for (const fixture of FIXTURES) {
      const step = stepOf(await fixture.run())
      if (step.next_tool) {
        expect(fixture.shape, `${fixture.site}: a named handoff must declare its variant`).toBeDefined()
        const shape = SIGNER_HOSTED_HANDOFF_SHAPES[fixture.shape!]
        expect(shape, fixture.site).toBeDefined()
        expect(
          z.object(shape).strict().safeParse(step.next_arguments).success,
          `${fixture.site}: ${JSON.stringify(step.next_arguments)} under ${String(fixture.shape)}`,
        ).toBe(true)
        expect(step.next_tool_server_role, fixture.site).toBe('hosted')
        expect(step.next_tool_name, fixture.site).toBe(String(fixture.shape).split('#')[0])
        expect(step.next_tool, fixture.site).toBe(`mcp__haven__${String(step.next_tool_name)}`)
      } else {
        expect(typeof step.next_tool_omitted_reason, fixture.site).toBe('string')
        // The SDK builder's silent fallback: a misspelled or unregistered
        // target would otherwise pass as "a reason".
        expect(step.next_tool_omitted_reason, fixture.site).not.toMatch(
          /not a registered next-step target|do not parse under/,
        )
      }
    }
  })

  for (const fixture of FIXTURES) {
    it(fixture.site, async () => {
      const out = await fixture.run()
      expect(stepOf(out)).toEqual(fixture.step(out))
      // A success result carries the `next_tool` family only — never a
      // decision (`next_action` / `safe_to_continue` stay on refusals).
      expect('next_action' in out).toBe(false)
      expect('safe_to_continue' in out).toBe(false)
    })
  }
})
