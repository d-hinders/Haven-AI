import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentPaymentNextAction, type AgentPaymentSummary } from '@haven_ai/sdk'
import { SIGNER_HOSTED_HANDOFF_SHAPES, toolSchemas as signerToolSchemas } from '@haven_ai/signer'
import { buildAgentGuidance } from './tools/support/guidance.js'

/**
 * #3101 — the hosted server declares the signer handoff shapes itself (it
 * must not import the edge signer at runtime); this pins them to the signer's
 * real schemas. Every signer handoff the hosted server emits must parse under
 * the signer's STRICT schema, and a key the signer does not declare must be
 * refused by the hosted map too. Test-time import of `@haven_ai/signer` only.
 */
const summary = { payment_id: 'pay_1', status: 'pending_signature' } as unknown as AgentPaymentSummary

describe('hosted signer handoffs parse under the signer\'s own schemas (#3101)', () => {
  for (const tool of ['haven_sign', 'haven_sign_x402'] as const) {
    it(`${tool}: the emitted next_arguments are accepted by the signer, strictly`, () => {
      const out = buildAgentGuidance({
        nextTool: tool,
        nextArguments: { payment_id: 'pay_1' },
        nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
        safeToContinue: true,
        reason: 'r',
        summary,
      })
      expect(out.next_tool).toBe(`mcp__haven-signer__${tool}`)
      const strict = z.object(signerToolSchemas[tool]).strict()
      expect(strict.safeParse(out.next_arguments).success).toBe(true)
    })
  }

  it('the hosted map refuses a key the signer does not declare', () => {
    const out = buildAgentGuidance({
      nextTool: 'haven_sign',
      nextArguments: { payment_id: 'pay_1', nonce: '1' },
      nextAction: AgentPaymentNextAction.SignAndSubmitPayment,
      safeToContinue: true,
      reason: 'r',
      summary,
    } as unknown as Parameters<typeof buildAgentGuidance>[0])
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/do not parse under haven_sign: /)
    expect('nonce' in signerToolSchemas.haven_sign).toBe(false)
  })
})

/**
 * #3103 — the reverse direction: the SIGNER declares the hosted tools it hands
 * off to (it must not import the hosted server); those declared shapes must
 * parse under the hosted server's own strict schemas, and every key the signer
 * declares must be one the hosted tool declares.
 */
describe('the signer\'s declared hosted handoffs parse under the hosted schemas (#3103)', () => {
  for (const [tool, shape] of Object.entries(SIGNER_HOSTED_HANDOFF_SHAPES)) {
    it(`${tool}: declared by the signer, accepted by the hosted server strictly`, async () => {
      const { toolSchemas } = await import('./tools/contracts.js')
      const hosted = toolSchemas[tool as keyof typeof toolSchemas]
      expect(hosted, tool).toBeDefined()
      for (const key of Object.keys(shape)) expect(Object.keys(hosted), `${tool}.${key}`).toContain(key)
      const sample = Object.fromEntries(Object.keys(shape).map((k) => [k, 'pay_1']))
      expect(z.object(hosted).strict().safeParse(sample).success).toBe(true)
    })
  }
})
