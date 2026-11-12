/**
 * #4829: "Haven did not answer usably" is not "Haven refused".
 *
 * All four signing-context fetches used to swallow a body that is not JSON to
 * `{}` and throw every non-2xx as `SIGN_CONTEXT_REFUSED`. A gateway's HTML 502
 * and the money-path rate limit's 429 therefore reached the agent as a refusal
 * by Haven — a payment Haven never looked at. The non-answer class (a body that
 * is not a JSON object at any non-2xx status, any 5xx, and a 429) is now
 * reported like the transport failure each flow already handles:
 * `SIGN_CONTEXT_UNREACHABLE`, that flow's existing step, and the
 * `typed_data_b64` relay where the flow has one. `SIGN_CONTEXT_REFUSED` stays
 * for a 4xx other than 429 whose body IS a JSON object.
 *
 * Everything here goes through `haven_sign` — the surface an MCP client
 * actually calls — so the assertions are on the wire result, not on an
 * internal throw. The refusal-class pins come FIRST and are re-asserted after
 * the widening: the change must move the non-answer class and nothing else.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolFailure } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d',
).address
const IDENTITY = { apiKey: 'sk_test_4829_secret', apiUrl: 'https://haven.test' }

type Flow = 'x402' | 'direct' | 'sub-budget' | 'task-budget'

/** The URL fragment that identifies each flow's own sign-context route. */
const ROUTE: Record<Flow, string> = {
  x402: '/x402/',
  direct: '/payments/',
  'sub-budget': '/sub-budgets/',
  'task-budget': '/task-budgets/',
}

/** The `haven_sign` arguments that reach each flow. */
const ARGS: Record<Flow, Record<string, string>> = {
  x402: { payment_id: 'pay_4829' },
  direct: { payment_id: 'pay_4829' },
  'sub-budget': { sub_budget_id: 'sb_4829' },
  'task-budget': { task_budget_id: 'tb_4829' },
}

const FLOWS: readonly Flow[] = ['x402', 'direct', 'sub-budget', 'task-budget']

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } })
}

/**
 * The x402 route's 409 `sign_context_unavailable` is the ONLY answer that makes
 * `haven_sign` reach the direct fetch (`tools.ts`'s `resolveSignContext`), so
 * the direct flow's stub answers it on the x402 route and the row's answer on
 * the direct route. Every other flow answers the row on its own route.
 */
function stubFetch(flow: Flow, answer: () => Response) {
  const calls: string[] = []
  const impl = (async (url: unknown) => {
    const path = String(url)
    calls.push(path)
    if (flow === 'direct' && path.includes(ROUTE.x402)) {
      return jsonResponse(409, {
        error: 'not an x402 payment',
        error_code: 'sign_context_unavailable',
      })
    }
    if (path.includes(ROUTE[flow])) return answer()
    throw new Error(`unexpected fetch: ${path}`)
  }) as typeof fetch
  return { impl, calls }
}

async function sign(flow: Flow, answer: () => Response) {
  const { impl, calls } = stubFetch(flow, answer)
  const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
  const handlers = createToolHandlers(signer, {
    signContext: { loadIdentity: async () => IDENTITY, fetchImpl: impl },
  })
  const result = await handlers.haven_sign(ARGS[flow])
  if (result.success) throw new Error(`expected a failure on ${flow}`)
  return { result: result as ToolFailure, calls }
}

/** The step each flow's TRANSPORT failure already gives (`sign-context.ts`). */
const TRANSPORT_STEP: Record<Flow, RegExp> = {
  x402: /re-run the SAME hosted quote tool with the same idempotency_key and include_signing_payload: true/,
  direct: /re-run whichever of haven_send \/ haven_pay you called, with the SAME idempotency_key/,
  'sub-budget': /retry the same haven_sign call with the same task_budget_id/,
  'task-budget': /retry the same haven_sign call with the same task_budget_id/,
}

/** Only the x402 and direct flows have a `typed_data_b64` relay to offer. */
const HAS_RELAY: Record<Flow, boolean> = {
  x402: true,
  direct: true,
  'sub-budget': false,
  'task-budget': false,
}

/**
 * The five non-answer shapes the issue names. "2xx-free HTML 404" is a 404
 * whose body is HTML: a platform edge's route-not-found page, not Haven's own
 * JSON refusal.
 */
const NON_ANSWERS = [
  { name: 'HTML 502', status: 502, answer: () => htmlResponse(502, '<html><body>Bad Gateway</body></html>') },
  { name: 'JSON 500', status: 500, answer: () => jsonResponse(500, { error: 'internal error' }) },
  { name: 'JSON 503', status: 503, answer: () => jsonResponse(503, { error: 'service unavailable' }) },
  { name: '429', status: 429, answer: () => jsonResponse(429, { error: 'rate limited' }, { 'Retry-After': '30' }) },
  { name: 'HTML 404', status: 404, answer: () => htmlResponse(404, '<html><body>Not Found</body></html>') },
] as const

describe('the non-answer class is SIGN_CONTEXT_UNREACHABLE, never "Haven refused" (#4829)', () => {
  for (const flow of FLOWS) {
    for (const row of NON_ANSWERS) {
      it(`${flow} × ${row.name}: unreachable, that flow's transport step, http_status carried`, async () => {
        const { result, calls } = await sign(flow, row.answer)

        expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
        // The whole point of the issue: Haven did not look at the payment, so
        // the signer must not tell the agent it refused one.
        expect(result.message).not.toMatch(/refused/i)
        expect(result.message).toMatch(/did not answer/)
        expect(result.http_status).toBe(row.status)
        expect(result.next_action).toBe('stop_and_tell_user')
        // No result in the non-answer class carries a signature.
        expect('signature' in result).toBe(false)

        if (HAS_RELAY[flow]) {
          expect(result.fallback).toBe('typed_data_b64')
          expect(result.message).toMatch(/typed_data_b64/)
        } else {
          expect('fallback' in result).toBe(false)
        }
        expect(result.next_tool_omitted_reason).toMatch(TRANSPORT_STEP[flow])

        // The signer never re-fetches on its own: the direct flow makes the
        // x402 request plus its own, every other flow exactly one.
        expect(calls).toHaveLength(flow === 'direct' ? 2 : 1)
      })
    }
  }

  it('a 429 cites the Retry-After wait and says to re-call the same tool with the same arguments once', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(429, { error: 'rate limited' }, { 'Retry-After': '30' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect(result.message).toMatch(/Retry-After: 30/)
    expect(result.message).toMatch(
      /re-call the same signer tool with the same arguments once after 30 seconds/,
    )
    // No new result field, and the signer does not sleep.
    expect('retry_after' in result).toBe(false)
    expect('retry_after_seconds' in result).toBe(false)
  })

  it('a 429 without a whole-seconds Retry-After says "a short wait" and cites no number', async () => {
    const { result } = await sign('x402', () => jsonResponse(429, { error: 'rate limited' }))
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect(result.message).toMatch(/once after a short wait/)
    expect(result.message).not.toMatch(/Retry-After/)
    expect(result.message).not.toMatch(/\d+ seconds/)
  })

  it('a 429 with an HTTP-date Retry-After is not cited as a wait', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(429, { error: 'rate limited' }, { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect(result.message).toMatch(/once after a short wait/)
    expect(result.message).not.toMatch(/Retry-After/)
  })

  it('a 429 on the task-budget flow keeps its no-fallback step and still names the re-call', async () => {
    const { result } = await sign('task-budget', () =>
      jsonResponse(429, { error: 'rate limited' }, { 'Retry-After': '5' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect('fallback' in result).toBe(false)
    expect(result.message).toMatch(/once after 5 seconds/)
    expect(result.next_tool_omitted_reason).toMatch(TRANSPORT_STEP['task-budget'])
  })
})

describe('the refusal class is pinned first and unchanged after (#4829)', () => {
  it('x402 JSON 404 keeps SIGN_CONTEXT_REFUSED and its own hint', async () => {
    const { result } = await sign('x402', () => jsonResponse(404, { error: 'not found' }))
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(404)
    expect(result.message).toMatch(/Haven refused/)
    expect(result.message).toMatch(/check the payment_id came from this agent’s own quote/)
    expect('fallback' in result).toBe(false)
  })

  it('x402 JSON 410 keeps payment_window_expired and retry_with_new_quote', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(410, { error: 'Payment window expired', error_code: 'expired' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(410)
    expect(result.backend_error_code).toBe('expired')
    expect(result.next_action).toBe('payment_window_expired')
    expect(result.retry_with_new_quote).toBe(true)
    expect('fallback' in result).toBe(false)
  })

  it('x402 JSON 409 already_executed keeps its code, next_action and no fallback', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(409, { error: 'already executed', error_code: 'already_executed' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(409)
    expect(result.backend_error_code).toBe('already_executed')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect('fallback' in result).toBe(false)
  })

  it('x402 JSON 409 not_signable keeps its code, next_action and no fallback', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(409, { error: 'not signable', error_code: 'not_signable' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.backend_error_code).toBe('not_signable')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect('fallback' in result).toBe(false)
  })

  it('x402 JSON 426 client_outdated keeps its code, next_action and update hint', async () => {
    const { result } = await sign('x402', () =>
      jsonResponse(426, {
        error: 'client outdated',
        error_code: 'client_outdated',
        client_update: {
          package: '@haven_ai/signer',
          current: '0.1.0',
          required: true,
          upgrade_command: 'npx @haven_ai/connect doctor',
        },
      }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(426)
    expect(result.backend_error_code).toBe('client_outdated')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect('fallback' in result).toBe(false)
    expect(result.client_update).toBeDefined()
  })

  it('the direct fetch\'s older-backend 404 (JSON message, no error) keeps SIGN_CONTEXT_REFUSED with its fallback', async () => {
    const { result } = await sign('direct', () =>
      jsonResponse(404, { message: 'Route GET:/payments/x/sign-context not found' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(404)
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_tool_omitted_reason).toMatch(/ORIGINAL haven_send \/ haven_pay/)
  })

  it('the direct fetch\'s JSON 410 expired keeps payment_window_expired with no retry_with_new_quote', async () => {
    const { result } = await sign('direct', () =>
      jsonResponse(410, { error: 'Payment window expired', error_code: 'expired' }),
    )
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.next_action).toBe('payment_window_expired')
    expect('retry_with_new_quote' in result).toBe(false)
  })

  it('a JSON 404 on the sub-budget and task-budget flows stays a refusal', async () => {
    for (const flow of ['sub-budget', 'task-budget'] as const) {
      const { result } = await sign(flow, () => jsonResponse(404, { error: 'not found' }))
      expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
      expect(result.http_status).toBe(404)
      expect('fallback' in result).toBe(false)
    }
  })
})

describe('nothing else moves (#4829)', () => {
  it('only a JSON 409 sign_context_unavailable on the x402 fetch reaches the direct fetch', async () => {
    // The 409 is the ONE x402 answer that makes haven_sign ask the direct
    // route; the direct route's own answer is what the agent then sees.
    const fellThrough = await sign('direct', () => jsonResponse(404, { error: 'not found' }))
    expect(fellThrough.calls).toHaveLength(2)
    expect(fellThrough.calls[0]).toContain(ROUTE.x402)
    expect(fellThrough.calls[1]).toContain(ROUTE.direct)
    expect(fellThrough.result.code).toBe('SIGN_CONTEXT_REFUSED')

    // Every other x402 answer stops at the x402 fetch.
    for (const row of NON_ANSWERS) {
      const { calls } = await sign('x402', row.answer)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(ROUTE.x402)
    }
  })

  it('a 5xx, a 429 or a non-JSON answer on the x402 fetch makes exactly one request', async () => {
    for (const row of NON_ANSWERS) {
      const { calls } = await sign('x402', row.answer)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(ROUTE.x402)
    }
  })
})
