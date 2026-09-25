/**
 * #3303: the signer names itself on its only backend contact — the two
 * sign-context reads — and turns the backend's answer into something an agent
 * can act on:
 *
 * - a 426 `client_outdated` refusal (this signer is below a minimum the
 *   deployment set) becomes a structured refusal: NO signature, the update
 *   command as data, and the reason no tool follows;
 * - a `client_update` hint on a successful read rides onto the signing result.
 *
 * Owner decision (2026-09-25, #3303): the refusal comes after prepare, so the
 * contract for the signer is "nothing signed or submitted" — the prepared
 * payment is left unsigned.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildBoundDirectUserOp } from '@haven_ai/sdk/test-support'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolFailure } from './tools.js'
import { SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS } from './sign-context.js'
import { buildSignerMcpServer, SIGNER_NAME, SIGNER_VERSION } from './server.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_DELEGATE_ADDRESS = privateKeyToAccount(TEST_KEY).address
const IDENTITY = { apiKey: 'sk_agent_test_3303', apiUrl: 'https://haven.test' }
const CLIENT = `${SIGNER_NAME}/${SIGNER_VERSION}`

const OUTDATED = {
  error: `@haven_ai/signer ${SIGNER_VERSION} is below the minimum version this Haven deployment accepts here (9.0.0).`,
  error_code: 'client_outdated',
  client_update: {
    package: '@haven_ai/signer',
    current: SIGNER_VERSION,
    recommended: '9.1.0',
    min_version: '9.0.0',
    required: true,
    upgrade_command: 'npx -y @haven_ai/connect@alpha',
    notes_url: null,
  },
  next_action: 'stop_and_tell_user',
}

function directBody(extra: Record<string, unknown> = {}) {
  const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS })
  return {
    payment_id: 'pay_direct',
    status: 'pending_signature',
    direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
    sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData },
    ...extra,
  }
}

/** Routes the two sign-context reads and records the client header each one carried. */
function recordingFetch(routes: { x402: () => Response; direct?: () => Response }) {
  const seen: Array<{ path: string; client: string | null }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    seen.push({ path, client: new Headers(init?.headers).get('x-haven-client') })
    if (path.includes('/x402/')) return routes.x402()
    if (path.includes('/payments/') && routes.direct) return routes.direct()
    throw new Error(`unexpected fetch: ${path}`)
  }) as typeof fetch
  return { fetchImpl, seen }
}

const x402Unavailable = () =>
  new Response(JSON.stringify({ error: 'not an x402 payment', error_code: 'sign_context_unavailable' }), { status: 409 })

function handlers(fetchImpl: typeof fetch) {
  return createToolHandlers(createEdgeSigner(TEST_KEY), {
    signContext: { loadIdentity: async () => IDENTITY, fetchImpl, clientIdentity: CLIENT },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('signer client identity (#3303)', () => {
  it('SIGNER_VERSION is this package\'s version — release-bump owns both', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
    expect(SIGNER_VERSION).toBe(pkg.version)
  })

  it('both sign-context reads carry X-Haven-Client', async () => {
    const { fetchImpl, seen } = recordingFetch({ x402: x402Unavailable, direct: () => new Response(JSON.stringify(directBody())) })
    const result = await handlers(fetchImpl).haven_sign({ payment_id: 'pay_direct' })
    expect(result.success).toBe(true)
    expect(seen.map((s) => s.path)).toEqual([
      'https://haven.test/x402/pay_direct/sign-context',
      'https://haven.test/payments/pay_direct/sign-context',
    ])
    expect(seen.map((s) => s.client)).toEqual([CLIENT, CLIENT])
  })

  it('the real server wires its own name and version — not left to a caller', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-3303-'))
    const credentialsPath = join(dir, 'signer.json')
    await writeFile(join(dir, 'identity.json'), JSON.stringify({ api_key: IDENTITY.apiKey, api_url: IDENTITY.apiUrl }))
    const seen: Array<string | null> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(new Headers(init?.headers).get('x-haven-client'))
      return new Response(JSON.stringify(OUTDATED), { status: 426 })
    })
    const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY), {
      credentials: { sourcePath: credentialsPath } as never,
      auditPath: join(dir, 'audit.log'),
    })
    const tools = (server as unknown as { _registeredTools: Record<string, { handler?: (a: unknown) => Promise<unknown>; callback?: (a: unknown) => Promise<unknown> }> })._registeredTools
    const entry = tools.haven_sign
    await (entry.handler ?? entry.callback)!({ payment_id: 'pay_x' })
    expect(seen).toEqual([CLIENT])
  })
})

describe('client_outdated at sign-context (#3303)', () => {
  it.each([
    ['haven_sign, x402 read', 'haven_sign' as const, { x402: () => new Response(JSON.stringify(OUTDATED), { status: 426 }) }],
    ['haven_sign, direct read', 'haven_sign' as const, { x402: x402Unavailable, direct: () => new Response(JSON.stringify(OUTDATED), { status: 426 }) }],
    ['haven_sign_x402', 'haven_sign_x402' as const, { x402: () => new Response(JSON.stringify(OUTDATED), { status: 426 }) }],
  ])('%s: refused, no signature, the update command as data', async (_label, tool, routes) => {
    const { fetchImpl } = recordingFetch(routes)
    const result = await handlers(fetchImpl)[tool]({ payment_id: 'pay_x' })
    expect(result.success).toBe(false)
    const failure = result as ToolFailure
    expect(failure).not.toHaveProperty('data')
    expect(failure.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(failure.http_status).toBe(426)
    expect(failure.backend_error_code).toBe('client_outdated')
    expect(failure.client_update).toEqual(OUTDATED.client_update)
    expect(failure.next_action).toBe('stop_and_tell_user')
    // No bytes to relay and no tool to call can help: only an update.
    expect(failure.fallback).toBeUndefined()
    expect(failure.next_tool).toBeUndefined()
    expect(failure.next_tool_omitted_reason).toContain('npx -y @haven_ai/connect@alpha')
  })
})

describe('client_update hint on a successful read (#3303)', () => {
  it('rides onto the signing result', async () => {
    const hint = { ...OUTDATED.client_update, required: false, min_version: null }
    const { fetchImpl } = recordingFetch({
      x402: x402Unavailable,
      direct: () => new Response(JSON.stringify(directBody({ client_update: hint }))),
    })
    const result = await handlers(fetchImpl).haven_sign({ payment_id: 'pay_direct' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect((result.data as { client_update?: unknown }).client_update).toEqual(hint)
  })

  it('is absent when the backend sent none', async () => {
    const { fetchImpl } = recordingFetch({ x402: x402Unavailable, direct: () => new Response(JSON.stringify(directBody())) })
    const result = await handlers(fetchImpl).haven_sign({ payment_id: 'pay_direct' })
    if (!result.success) throw new Error('expected success')
    expect(result.data).not.toHaveProperty('client_update')
  })
})
