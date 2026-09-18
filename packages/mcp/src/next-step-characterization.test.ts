import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'

/**
 * #3103 (epic #3105, slice 4/5) — CHARACTERIZATION of the local runtime's one
 * `next_action` DECISION site (`MerchantNotReadyError`, `tools.ts`) before the
 * typed step and the decision-10 spelling convergence land. Today the local
 * failure envelope spells it `nextAction` and carries no `next_action`, no
 * `next_tool*` and no `next_tool_omitted_reason`.
 */
describe('local runtime refusal wire — characterization (#3103)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('merchant_not_ready: nextAction only, no next_action twin, no typed step', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      if (body?.method === 'initialize') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ error: 'merchant_not_ready', reason_code: 'fail_floor_reached', settlements_remaining: 0, retry_after_s: 30 }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    })
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test', delegateKey: '0x' + 'd'.repeat(64) })
    const result = await createToolHandlers(haven).haven_pay_mcp_tool({ merchant_url: 'http://merchant.test/mcp', tool_name: 'buy_vpn' })
    if (result.success) throw new Error('expected failure')
    const out = result as unknown as Record<string, unknown>
    expect(out.code).toBe('MERCHANT_NOT_READY')
    expect(out.nextAction).toBe('stop_and_tell_user')
    expect(out.retry_with_new_quote).toBe(true)
    expect(out.next_action).toBeUndefined()
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toBeUndefined()
  })
})
