import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolFailure } from './tools.js'

/**
 * #3103 (epic #3105, slice 4/5) — CHARACTERIZATION of the signer's refusal
 * wire, written BEFORE the typed next step landed (commit c163a2cd) and
 * carried across it: every field pinned there is byte-identical, and each
 * refusal now ALSO carries a typed step. The signer decides a `next_action`
 * at five sites (`sign-context.ts:98,101,105` on `HavenSignContextError`;
 * `tools.ts` version mismatch and the window-expired `HavenError` branch).
 * The four sign-context codes are driven here through `haven_sign`, the path
 * an MCP client calls; the other two are pinned in `version-skew.test.ts`
 * (`UNSUPPORTED_EXPECTED_CONTEXT_VERSION`) and `server.test.ts`
 * (`PAYMENT_WINDOW_EXPIRED` via `haven_x402_sign_header`). The structural
 * commit keeps every field pinned here byte-identical and ADDS `next_tool*`
 * or `next_tool_omitted_reason`.
 */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d').address
const IDENTITY = { apiKey: 'sk_agent_test_3103', apiUrl: 'https://haven.test' }

async function refusal(fetchImpl: typeof fetch): Promise<ToolFailure> {
  const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
  const handlers = createToolHandlers(signer, { signContext: { loadIdentity: async () => IDENTITY, fetchImpl } })
  const result = await handlers.haven_sign({ payment_id: 'pay_3103' })
  if (result.success) throw new Error('expected failure')
  return result
}
const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

export const SIGN_CONTEXT_SITES = [
  { site: 'sign-context.ts transport timeout', fetch: (async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }) as typeof fetch, expect: { code: 'SIGN_CONTEXT_TIMEOUT', next_action: 'stop_and_tell_user', fallback: 'typed_data_b64' } },
  { site: 'sign-context.ts unreachable', fetch: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch, expect: { code: 'SIGN_CONTEXT_UNREACHABLE', next_action: 'stop_and_tell_user', fallback: 'typed_data_b64' } },
  { site: 'sign-context.ts refused 410 (expired)', fetch: json(410, { error: 'expired', error_code: 'expired' }), expect: { code: 'SIGN_CONTEXT_REFUSED', next_action: 'payment_window_expired', retry_with_new_quote: true, http_status: 410, backend_error_code: 'expired' } },
  { site: 'sign-context.ts refused other', fetch: json(409, { error: 'already executed', error_code: 'already_executed' }), expect: { code: 'SIGN_CONTEXT_REFUSED', next_action: 'stop_and_tell_user', http_status: 409, backend_error_code: 'already_executed' } },
  { site: 'sign-context.ts malformed body', fetch: json(200, { nonsense: true }), expect: { code: 'SIGN_CONTEXT_MALFORMED', next_action: 'stop_and_tell_user', fallback: 'typed_data_b64' } },
] as const

const PINNED = ['code', 'next_action', 'fallback', 'retry_with_new_quote', 'http_status', 'backend_error_code'] as const
const TRANSPORT_REASON = 're-run the SAME hosted quote tool with the same idempotency_key and include_signing_payload: true, then pass its typed_data_b64 to this signer'
const EXPIRED_REASON = 're-run the hosted quote tool you called with the same idempotency_key; which one depends on the flow'
/** The typed step each site adds (RE-DECIDED: additive on every site). */
const STEP: Record<string, Record<string, unknown>> = {
  'sign-context.ts transport timeout': { next_tool_omitted_reason: TRANSPORT_REASON },
  'sign-context.ts unreachable': { next_tool_omitted_reason: TRANSPORT_REASON },
  'sign-context.ts refused 410 (expired)': { next_tool_omitted_reason: EXPIRED_REASON },
  'sign-context.ts refused other': { next_tool: 'mcp__haven__haven_get_payment_status', next_tool_server: 'haven', next_tool_name: 'haven_get_payment_status', next_tool_server_role: 'hosted', next_arguments: { payment_id: 'pay_3103' } },
  'sign-context.ts malformed body': { next_tool_omitted_reason: TRANSPORT_REASON },
}
const STEP_KEYS = ['next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('signer refusal wire — characterization (#3103)', () => {
  it('registry walk: every refusal names a hosted tool whose arguments parse under the declared strict shape, or says why none follows', async () => {
    const { z } = await import('zod')
    const { SIGNER_HOSTED_HANDOFF_SHAPES } = await import('./next-step.js')
    for (const fixture of SIGN_CONTEXT_SITES) {
      const out = (await refusal(fixture.fetch)) as unknown as Record<string, unknown>
      if (out.next_tool) {
        const name = out.next_tool_name as keyof typeof SIGNER_HOSTED_HANDOFF_SHAPES
        expect(SIGNER_HOSTED_HANDOFF_SHAPES[name], fixture.site).toBeDefined()
        expect(z.object(SIGNER_HOSTED_HANDOFF_SHAPES[name]).strict().safeParse(out.next_arguments).success, fixture.site).toBe(true)
        expect(out.next_tool_server_role).toBe('hosted')
      } else {
        expect(typeof out.next_tool_omitted_reason, fixture.site).toBe('string')
      }
    }
  })

  for (const fixture of SIGN_CONTEXT_SITES) {
    it(fixture.site, async () => {
      const out = (await refusal(fixture.fetch)) as unknown as Record<string, unknown>
      const picked = Object.fromEntries(PINNED.filter((k) => out[k] !== undefined).map((k) => [k, out[k]]))
      expect(picked).toEqual(fixture.expect)
      const step = Object.fromEntries(STEP_KEYS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]]))
      expect(step).toEqual(STEP[fixture.site])
      expect(JSON.stringify(out)).not.toContain(IDENTITY.apiKey)
    })
  }
})
