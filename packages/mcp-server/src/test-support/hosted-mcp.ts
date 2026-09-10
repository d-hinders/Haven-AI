/**
 * Shared hosted-MCP test fixture (#2808) — the one reusable fetch/x402 setup
 * for the mcp-server suites.
 *
 * The duplicated stubs this replaces: `tools.test.ts` (the superset — recorded
 * calls, MCP streamable-HTTP handshake modeling, x402 status-route fallback),
 * `report-x402-outcome.test.ts` (subset: same stub without handshake/status
 * default), `hosted-quote-body.test.ts` and `strict-tool-input.test.ts`
 * (specialized stubs that did NOT match the shared shape — they keep their
 * local helpers deliberately). `PAYMENT_REQUIRED` had three divergent copies;
 * the wire-contract variant pins v2 WITH missing fields on purpose, so only
 * the tools/hosted-signer v1 shape moved here as `PAYMENT_REQUIRED`.
 *
 * Later capability splits (#2809–#2812) colocate handler tests against THIS
 * fixture rather than cloning it.
 */
import { beforeEach, afterEach, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import {
  createToolHandlers,
  type HostedToolName,
  type ToolPayload,
  type ToolSuccess,
} from '../tools.js'

/** `0x` + 64 hex a's — the delegate key NO request may ever carry. */
export const DELEGATE_KEY = '0x' + 'a'.repeat(64)
/** `0x` + 32× `12` — header-signing client key (fixtures only, never relayed). */
export const HEADER_SIGNING_KEY = '0x' + '12'.repeat(32)
/** The expected-auth fixture the x402 quote/prepare routes return. */
export const X402_EXPECTED_AUTH = {
  version: 1 as const,
  message: 'Haven x402 expected context v1\n{}',
  signature: '0x' + '11'.repeat(65),
  signer: '0x000000000000000000000000000000000000bEEF',
}

export interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

export interface RouteDefinition {
  status?: number
  body?: unknown
  /** Extra response headers to include. */
  responseHeaders?: Record<string, string>
}

let calls: CapturedCall[]

/** Every fetch the current stub recorded — url/method/body/headers. */
export function recordedCalls(): CapturedCall[] {
  return calls
}

/**
 * Install the shared fetch stub. Records every request, models the MCP
 * streamable-HTTP lifecycle (initialize → mcp-session-id, notifications/initialized
 * → 202) for configured routes, and answers unconfigured
 * `GET /machine-payments/:id/status` with the default preflight status.
 */
export function stubFetch(routes: Record<string, RouteDefinition>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({
      url,
      method,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    const route = routes[`${method} ${path}`]
    // Paid MCP-tool tests model a strict streamable-HTTP merchant: before its
    // configured 402 tool response, it establishes an MCP session and expects
    // the lifecycle notification. This keeps existing route fixtures focused
    // on the payment state they exercise while asserting the hosted flow uses
    // the real transport sequence.
    if (route && route.status !== 404 && method === 'POST' && body?.method === 'initialize') {
      const responseHeaders = new Headers({ 'mcp-session-id': 'sess-tools-test' })
      const bodySnapshot = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }
      return {
        ok: true,
        status: 200,
        headers: responseHeaders,
        json: async () => bodySnapshot,
        text: async () => JSON.stringify(bodySnapshot),
        clone: () => ({
          ok: true,
          status: 200,
          headers: responseHeaders,
          json: async () => bodySnapshot,
          text: async () => JSON.stringify(bodySnapshot),
        }),
      }
    }
    if (route && route.status !== 404 && method === 'POST' && body?.method === 'notifications/initialized') {
      const responseHeaders = new Headers()
      return {
        ok: true,
        status: 202,
        headers: responseHeaders,
        json: async () => ({}),
        text: async () => '',
        clone: () => ({ ok: true, status: 202, headers: responseHeaders, json: async () => ({}), text: async () => '' }),
      }
    }
    const status = route?.status ?? 200
    const responseHeaders = new Headers(route?.responseHeaders ?? {})
    const bodySnapshot = route?.body ?? (
      method === 'GET' && /^\/machine-payments\/[^/]+\/status$/.test(path)
        ? x402PreflightStatus()
        : undefined
    )
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      json: async () => bodySnapshot ?? {},
      text: async () => JSON.stringify(bodySnapshot ?? {}),
      clone: () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: responseHeaders,
        json: async () => bodySnapshot ?? {},
        text: async () => JSON.stringify(bodySnapshot ?? {}),
      }),
    }
    return response
  })
}

/** Shared afterEach hygiene for every suite using `stubFetch`. */
export function unstubAfterEach(): void {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
}

/** Unwrap a ToolPayload or throw with the failure message. */
export function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

/** Unwrap a failing ToolPayload (typed refusal shape). */
export function fail(payload: ToolPayload) {
  if (payload.success) throw new Error('expected failure, got success')
  return payload
}

/** Keyless client against the stubbed backend, wired to the full handler set. */
export function handlers(): Record<HostedToolName, (input: unknown) => Promise<ToolPayload>> {
  const haven = new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
  return createToolHandlers(haven)
}

/** A client that can mint REAL payment headers through the SDK funding leg. */
export function headerSignerClient(): HavenClient {
  return new HavenClient({
    apiKey: 'test-key',
    delegateKey: HEADER_SIGNING_KEY,
    baseUrl: 'http://haven.test',
  })
}

/** Keyless client for direct spy-based handler sets. */
export function keylessClient(): HavenClient {
  return new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' })
}

/** Clear the recorded-call buffer (auto-reset by the installed beforeEach). */
export function clearCalls(): void {
  calls = []
}

/** Install the shared per-test lifecycle: reset calls, unstub after each. */
export function installSharedFixtureLifecycle(): void {
  beforeEach(() => {
    calls = []
  })
  unstubAfterEach()
}

export const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      maxAmountRequired: '1500000',
      // Base USDC — selectStandardPaymentOption only accepts this asset.
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
}

/**
 * Mint the canonical REAL v1/v2 payment headers once per suite through the
 * SDK's funding-leg signing path — a hand-rolled header here would stop
 * testing the SDK and start testing this file (see tools.test.ts #1618 note).
 * Call once in `beforeAll`; headers land in VALID_PAYMENT_HEADER(_V2).
 */
export const VALID_PAYMENT_HEADER_REF = { v1: '', v2: '' }

export async function mintPaymentHeaders(paymentRequired = PAYMENT_REQUIRED): Promise<void> {
  type HeaderMinter = {
    fundingLeg: {
      createPaymentHeader(
        paymentRequired: typeof PAYMENT_REQUIRED,
        option: (typeof PAYMENT_REQUIRED.accepts)[number],
      ): Promise<string>
    }
  }
  const mint = (headerSignerClient() as unknown as HeaderMinter).fundingLeg
  VALID_PAYMENT_HEADER_REF.v1 = await mint.createPaymentHeader(
    paymentRequired,
    paymentRequired.accepts[0],
  )
  VALID_PAYMENT_HEADER_REF.v2 = await mint.createPaymentHeader(
    { ...paymentRequired, x402Version: 2 },
    paymentRequired.accepts[0],
  )
}

export function x402PreflightStatus(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: 'pay_x402',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'pending_signature',
    phase: 'awaiting_agent_signature',
    next_action: 'sign_and_submit',
    amount: '1.50',
    token: 'USDC',
    resource_url: PAYMENT_REQUIRED.resource.url,
    merchant_address: PAYMENT_REQUIRED.accepts[0].payTo,
    payer_address: headerSignerClient().delegateAddress,
    tx_hash: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'Ready to sign.',
    amount_atomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    ...overrides,
  }
}

/** Decode a base64url X-PAYMENT header, mutate it, re-encode. */
export function mutateHeader(
  paymentHeader: string,
  mutate: (header: Record<string, unknown>) => void,
): string {
  const header = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as Record<string, unknown>
  mutate(header)
  return Buffer.from(JSON.stringify(header), 'utf8').toString('base64')
}

export const X402_INTENT_RESPONSE = {
  payment_id: 'pay_x402',
  status: 'pending_signature',
  expires_at: '2099-01-01T00:00:00.000Z',
  merchant_to: '0xMerchant',
  x402_expected_auth: X402_EXPECTED_AUTH,
  sign_data: { hash: '0xfunding' },
}

export const AGENT_RESPONSE = {
  id: 'agt_1',
  name: 'A',
  status: 'active',
  delegate_address: '0xDelegate',
  chain_id: 8453,
}

export const AGENT_ALLOWANCES_RESPONSE = {
  agent_id: 'agt_1',
  safe_address: '0xSafe',
  delegate_address: '0xDelegate',
  chain_id: 8453,
  allowances: [{
    id: 'allowance-1',
    // Real Base USDC address (6 decimals) so remainingDisplay exercises the
    // decimals lookup rather than the unknown-token atomic fallback.
    token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    token_symbol: 'USDC',
    configured_amount: '10000',
    reset_period_min: 60,
    onchain: {
      amount: '10000', spent: '2500', remaining: '7500', effective_spent: '2500',
      reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
    },
  }],
}
