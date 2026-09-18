import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import { z } from 'zod'
import { HostedToolError, normalizeError, paymentWindowExpiredError } from './tools/support/errors.js'
import { refusalNextStep } from './tools/support/guidance.js'
import { REFUSAL_SITES, REFUSAL_SITE_COUNT, REFUSAL_STEP_CALLS } from './test-support/next-step-fixtures.js'

/**
 * #3102 (epic #3105, slice 3/5) — CHARACTERIZATION of the hosted REFUSAL
 * sites that name a `next_action`, written BEFORE they were moved onto the
 * typed builder (commit a5b6aabc) and carried across it: every field pinned
 * there is unchanged, and each site now ALSO carries the typed step — a tool
 * with arguments that tool declares, or `next_tool_omitted_reason`. #3101
 * typed the 17 `buildAgentGuidance` sites; these are the other 30 (31
 * fixtures: the eip3009 rejection has a live-state branch). The
 * census was originally derived from `nextAction:` lines minus the builder's
 * call sites; it now counts `refusalNextStep(` calls: 29 inline site steps,
 * the 3 branches of `rejectedAfterFundingStep` and the 5 branches of the
 * payment-state mapper in errors.ts (`stateErrorNextStep`, decision 9's
 * default table) — 37, with the helpers pinned by their own tests. Round 3 of
 * #3126 migrated the three check_funds cap refusals in
 * `state-direct-recovery.ts` onto the builder (29 = 26 + 3) and added their
 * fixtures here in the same commit. Each fixture mirrors one
 * site's `HostedToolError` input (code, action, suggested_tool, whether a
 * payment id is known) and pins what `normalizeError` puts on the wire for
 * it. The structural commit keeps every pinned field byte-identical and ADDS
 * the typed next step (a tool + arguments, or `next_tool_omitted_reason`);
 * the delta per site is listed in the PR body and updated here in the same
 * commit.
 */
// The census constants live with the fixtures (`test-support/next-step-fixtures.ts`).

function hostedSource(): string {
  const parts = [readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')]
  const walk = (dir: URL) => {
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir))
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        parts.push(readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8'))
    }
  }
  walk(new URL('./tools/', import.meta.url))
  return parts.join('\n')
}

const NEXT_KEYS = ['next_action', 'suggested_tool', 'next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('hosted refusal next-step emissions — characterization (#3102)', () => {
  it(`census: ${REFUSAL_STEP_CALLS} refusal steps are built in the hosted source (refusalNextStep calls; a bare nextAction on HostedToolError no longer compiles)`, () => {
    const source = hostedSource()
    const calls = [...source.matchAll(/(?<!function )refusalNextStep\(/g)].length
    expect(calls).toBe(REFUSAL_STEP_CALLS)
    expect(REFUSAL_SITES).toHaveLength(REFUSAL_SITE_COUNT)
  })

  for (const fixture of REFUSAL_SITES) {
    it(fixture.site, () => {
      const err = fixture.step === 'window-expired-helper'
        ? paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', rail: 'x402' })
        : new HostedToolError({ ...fixture.base, nextStep: refusalNextStep(fixture.step) })
      const out = normalizeError(err) as unknown as Record<string, unknown>
      expect(out.success).toBe(false)
      const picked = Object.fromEntries(NEXT_KEYS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]]))
      expect(picked).toEqual(fixture.expect)
    })
  }

  it('registry walk: every refusal names a tool whose arguments parse under its strict schema, or says why none follows', async () => {
    const { toolSchemas } = await import('./tools/contracts.js')
    for (const fixture of REFUSAL_SITES) {
      const err = fixture.step === 'window-expired-helper'
        ? paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', rail: 'x402' })
        : new HostedToolError({ ...fixture.base, nextStep: refusalNextStep(fixture.step) })
      const out = normalizeError(err)
      if (out.next_tool) {
        const name = out.next_tool_name as keyof typeof toolSchemas
        expect(toolSchemas[name], fixture.site).toBeDefined()
        const parsed = z.object(toolSchemas[name]).strict().safeParse(out.next_arguments)
        expect(parsed.success, `${fixture.site}: ${JSON.stringify(out.next_arguments)}`).toBe(true)
        expect(out.next_tool_omitted_reason).toBeUndefined()
      } else {
        expect(typeof out.next_tool_omitted_reason, fixture.site).toBe('string')
        expect((out.next_tool_omitted_reason as string).length).toBeGreaterThan(10)
      }
      expect(out.next_action, fixture.site).toBeDefined()
    }
  })
})
