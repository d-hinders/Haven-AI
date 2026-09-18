import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import { buildAgentGuidance } from './tools/support/guidance.js'
import { EMISSION_SITES } from './test-support/next-step-fixtures.js'

/**
 * #3101 (epic #3105, slice 2/5) — CHARACTERIZATION of the 17 hosted
 * next-step emissions (13 tool-naming sites plus the four no-tool sites), written BEFORE the typed builder landed (commit
 * 74cd61da) and carried across it: the inputs are now in the builder's
 * vocabulary (bare tool names, `nextTool: null` + reason where no tool is
 * named) and every expectation is byte-identical to the pre-#3101 wire
 * except the sites the epic re-decided, marked `RE-DECIDED` below. Each fixture is the
 * literal `buildAgentGuidance` input one emission site passes (ids
 * substituted), and the expected `next_*` wire fields are what the pre-#3101
 * builder produced for it. The structural commit that follows must keep every
 * expectation byte-identical except the three `payment_id: null` sites, whose
 * new shape (omitted tool + `next_tool_omitted_reason`) is stated in the PR
 * body and updated here in the same commit.
 */
const SUMMARY = {
  payment_id: 'pay_1',
  status: 'pending_signature',
  amount_atomic: '1500000',
  asset: 'USDC',
  network: 'base',
} as unknown as Parameters<typeof buildAgentGuidance>[0]['summary']


/**
 * The census the figure "17 emission sites" comes from: every
 * `buildAgentGuidance(` call in the hosted non-test source. A new site fails
 * this count (haven-reviewer round 2 on #3124 planted an 18th and the suite
 * stayed green), and must then be characterized above. Distinct from the
 * fixture count (19: the held-hash site has two branches, the three null-id
 * sites share one helper) — the number the docs quote is THIS one.
 */
export const EMISSION_SITE_COUNT = 17

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

const NEXT_KEYS = ['next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('hosted next-step emissions — characterization (#3101)', () => {
  it(`the hosted source has exactly ${EMISSION_SITE_COUNT} buildAgentGuidance call sites (census)`, () => {
    // Excludes the definition in guidance.ts (`export function buildAgentGuidance(`).
    const calls = [...hostedSource().matchAll(/(?<!function )buildAgentGuidance\(/g)].length
    expect(calls).toBe(EMISSION_SITE_COUNT)
  })

  for (const fixture of EMISSION_SITES) {
    it(fixture.site, () => {
      const f = fixture as { tool?: string | null; reason?: string; args?: unknown; handoff?: unknown }
      const handoff = (f.handoff
        ? f.handoff
        : f.tool === null
          ? { nextTool: null, nextToolOmittedReason: f.reason }
          : { nextTool: f.tool, nextArguments: f.args }) as unknown as Parameters<typeof buildAgentGuidance>[0]
      const out = buildAgentGuidance({
        ...handoff,
        nextAction: fixture.action,
        safeToContinue: true,
        reason: 'r',
        summary: SUMMARY,
      })
      const picked = Object.fromEntries(NEXT_KEYS.filter((k) => k in out).map((k) => [k, (out as unknown as Record<string, unknown>)[k]]))
      expect(picked).toEqual(fixture.expect)
      expect(out.next_action).toBe(fixture.action)
    })
  }
})
