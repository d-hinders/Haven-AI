import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentPaymentNextAction, type AgentPaymentSummary } from '@haven_ai/sdk'
import { SIGNER_HOSTED_HANDOFF_SHAPES, toolSchemas as signerToolSchemas } from '@haven_ai/signer'
import { DEFAULT_NEXT_TOOL_BY_ACTION } from '@haven_ai/sdk'
import { buildAgentGuidance, refusalNextStep } from './tools/support/guidance.js'
import { HostedToolError, normalizeError, paymentWindowExpiredError } from './tools/support/errors.js'
import { EMISSION_FIXTURE_COUNT, EMISSION_SITES, REFUSAL_SITES, REFUSAL_SITE_COUNT } from './test-support/next-step-fixtures.js'

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

/**
 * #3104 — the cross-surface walk (extends #3100's parity, one test, never a
 * second): every hosted response fixture the epic characterized — the 17
 * `buildAgentGuidance` sites and the 28 refusal steps — is built for real,
 * and each emitted (`next_tool`, `next_arguments`) pair is parsed with the
 * NAMED tool's declared schema on the surface its role points at: hosted →
 * hosted `toolSchemas`, hosted → signer `toolSchemas` (the published package's
 * own, aliased from its built dist), both strict. Decision 9 rides along:
 * every emission whose `next_action` has a default-table mapping names a tool.
 * Signer → hosted is the describe above; local → local is the discovery
 * parity in `packages/mcp/src/tools.test.ts`. Mutating one emitted argument
 * name in any package turns one of these three red (quoted in PR #3104).
 */
describe('every hosted emission parses under the named tool\'s schema on the surface its role names (#3104)', () => {
  const summary = { payment_id: 'pay_1', status: 'pending_signature' } as unknown as AgentPaymentSummary
  const emitted: Array<{ site: string; out: Record<string, unknown> }> = []
  for (const f of EMISSION_SITES) {
    const fx = f as { site: string; action: AgentPaymentNextAction; tool?: string | null; args?: unknown; reason?: string; handoff?: unknown }
    const handoff = (fx.handoff ? fx.handoff : fx.tool === null ? { nextTool: null, nextToolOmittedReason: fx.reason } : { nextTool: fx.tool, nextArguments: fx.args }) as unknown as Parameters<typeof buildAgentGuidance>[0]
    emitted.push({ site: fx.site, out: buildAgentGuidance({ ...handoff, nextAction: fx.action, safeToContinue: true, reason: 'r', summary }) as unknown as Record<string, unknown> })
  }
  for (const f of REFUSAL_SITES) {
    const err = f.step === 'window-expired-helper'
      ? paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', rail: 'x402' })
      : new HostedToolError({ ...f.base, nextStep: refusalNextStep(f.step) })
    emitted.push({ site: `refusal: ${f.site}`, out: normalizeError(err) as unknown as Record<string, unknown> })
  }

  it(`walks every fixture: ${EMISSION_FIXTURE_COUNT} success + ${REFUSAL_SITE_COUNT} refusal (the census constants, not the arrays' own lengths)`, () => {
    expect(EMISSION_SITES).toHaveLength(EMISSION_FIXTURE_COUNT)
    expect(REFUSAL_SITES).toHaveLength(REFUSAL_SITE_COUNT)
    expect(emitted).toHaveLength(EMISSION_FIXTURE_COUNT + REFUSAL_SITE_COUNT)
  })

  for (const { site, out } of emitted) {
    it(site, async () => {
      const { toolSchemas: hosted } = await import('./tools/contracts.js')
      if (out.next_tool) {
        const role = out.next_tool_server_role as 'hosted' | 'signer'
        const name = out.next_tool_name as string
        const map = role === 'signer' ? (signerToolSchemas as Record<string, z.ZodRawShape>) : (hosted as Record<string, z.ZodRawShape>)
        expect(map[name], `${site}: ${role}/${name} is not a declared tool`).toBeDefined()
        const parsed = z.object(map[name]).strict().safeParse(out.next_arguments)
        expect(parsed.success, `${site}: ${JSON.stringify(out.next_arguments)} under ${role}/${name}`).toBe(true)
        expect(out.next_tool).toBe(`mcp__${role === 'signer' ? 'haven-signer' : 'haven'}__${name}`)
      } else {
        expect(typeof out.next_tool_omitted_reason, `${site}: no tool and no reason`).toBe('string')
      }
      // Decision 9: an action with a table default names a tool.
      const action = out.next_action as keyof typeof DEFAULT_NEXT_TOOL_BY_ACTION
      if (action in DEFAULT_NEXT_TOOL_BY_ACTION) expect(out.next_tool, `${site}: ${action} has a default but names no tool`).toBeDefined()
    })
  }
})
