/**
 * #2330 — every agent-facing mention of the x402 payment header names BOTH
 * wire names, across every surface an agent reads.
 *
 * ## What this exists to catch
 *
 * #2289 fixed the header name where Haven makes the request: `deliverPayment`
 * sets `PAYMENT-SIGNATURE` and `X-PAYMENT` to the same value, and every
 * SDK-driven retry routes through it. Eight tests pin that.
 *
 * It did not fix the header name where Haven *tells the agent* to make the
 * request — and `haven_pay_x402_quote`'s whole premise is "retry the merchant
 * YOURSELF". Three descriptions still said `X-PAYMENT` alone, two more named
 * no header at all, and NOTHING anywhere named `PAYMENT-SIGNATURE` to an
 * agent. An agent following that guidance against a strict x402 v2 merchant
 * sets only the v1 name, the merchant ignores the header, and on the EIP-3009
 * bridge the funding leg has already moved the money — the epic's originating
 * CoinGecko failure, reproduced by following Haven's own instructions.
 *
 * Every one of #2289's tests exercised `deliverPayment`. None read a
 * description. The wire was pinned; the instruction telling anyone what to put
 * on the wire was not.
 *
 * ## Why the assertion is shaped this way
 *
 * Per-DESCRIPTION, not per-line: the legitimate form names both names, and
 * they routinely land on different lines of the same string. Purely literal —
 * it asks whether one substring appears when another does, and never
 * interprets a sentence (ship-next § Rework caps). It cannot verify that the
 * surrounding prose is *sensible*; human review is the control for that. What
 * it does guarantee is that no surface can go back to naming v1 alone.
 *
 * ## Scope, stated rather than assumed
 *
 * Covers the exported description records of all three tool surfaces an agent
 * reads, AND the SDK's `havenTools` tool definitions.
 *
 * That last one is here because the first version of this guard did not have
 * it, and was green while the primary defect sat un-covered: the SDK's
 * `AUTHORIZE_X402_DESCRIPTION` — the one string in this whole issue that says
 * "when doing a manual HTTP retry" in as many words — is not in
 * `toolDescriptions`, it is a `description` field on `havenTools.claude` /
 * `.openai`. Reverting it to its v1-only wording passed every test. Two
 * plausibly-named exports, only one of them the one that mattered; the guard
 * now walks both and a mutation confirms it.
 *
 * It does NOT cover runtime error strings, code comments, or the `reason`
 * field of `buildAgentGuidance` — `reason` is built per-call inside a handler
 * and is not reachable from a static record, so the two guidance strings this
 * issue fixed there are pinned separately in `tools.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { toolDescriptions as hostedDescriptions } from './tools.js'
import { toolDescriptions as signerDescriptions } from '@haven_ai/signer'
import { toolDescriptions as sdkDescriptions, havenTools } from '@haven_ai/sdk'

const V2_NAME = 'PAYMENT-SIGNATURE'
const V1_NAME = 'X-PAYMENT'

/** Flatten a shared-description record to one searchable string per key. */
function flatten(record: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(record).map(([name, value]) => [
    name,
    typeof value === 'string' ? value : JSON.stringify(value),
  ])
}

/** Every `description` on a tool definition, keyed by the tool's own name. */
function toolDefinitionDescriptions(defs: unknown): Array<[string, string]> {
  if (!Array.isArray(defs)) return []
  const out: Array<[string, string]> = []
  for (const def of defs) {
    const record = def as { name?: unknown; description?: unknown; function?: unknown }
    // OpenAI shape nests name+description under `function`.
    const fn = record.function as { name?: unknown; description?: unknown } | undefined
    const name = typeof record.name === 'string' ? record.name : fn?.name
    const description =
      typeof record.description === 'string' ? record.description : fn?.description
    if (typeof name === 'string' && typeof description === 'string') out.push([name, description])
  }
  return out
}

// `havenTools.claude` / `.openai` are zero-arg FACTORIES, not arrays — the
// first widening of this guard assumed arrays, got zero entries from both, and
// the non-vacuity assertion is what caught that rather than a silent pass.
const sdkToolDefs = havenTools as unknown as { claude: () => unknown; openai: () => unknown }
const sdkClaudeTools = sdkToolDefs.claude()
const sdkOpenaiTools = sdkToolDefs.openai()

const SURFACES: Array<[label: string, entries: Array<[string, string]>]> = [
  ['hosted MCP', flatten(hostedDescriptions as unknown as Record<string, unknown>)],
  ['edge signer', flatten(signerDescriptions as unknown as Record<string, unknown>)],
  ['sdk shared', flatten(sdkDescriptions as unknown as Record<string, unknown>)],
  ['sdk havenTools.claude', toolDefinitionDescriptions(sdkClaudeTools)],
  ['sdk havenTools.openai', toolDefinitionDescriptions(sdkOpenaiTools)],
]

describe('#2330 — no agent-facing surface names the v1 header alone', () => {
  it.each(SURFACES)('%s descriptions never name X-PAYMENT without PAYMENT-SIGNATURE', (_label, entries) => {
    // Non-vacuity: an empty record would satisfy every assertion below.
    expect(entries.length).toBeGreaterThan(0)

    for (const [name, description] of entries) {
      if (!description.includes(V1_NAME)) continue
      expect(
        description,
        `${name} names ${V1_NAME} without ${V2_NAME}. A strict x402 v2 merchant reads only ` +
          `${V2_NAME}; an agent told to send the legacy name alone reproduces the #2288 failure, ` +
          'with the funding leg already spent. Name both, v2 first.',
      ).toContain(V2_NAME)
    }
  })

  it('at least one surface actually names both — the guard is not vacuously green', () => {
    // Every assertion above is a conditional. If no description mentioned the
    // header at all they would all pass while the guidance said nothing, which
    // is the state #2291 left two of these strings in.
    const naming = SURFACES.flatMap(([, entries]) => entries).filter(
      ([, description]) => description.includes(V2_NAME) && description.includes(V1_NAME),
    )
    expect(naming.length).toBeGreaterThan(0)
  })

  it("the SDK's manual-retry instruction names both — the site the first guard missed", () => {
    // AUTHORIZE_X402_DESCRIPTION is the only string that explicitly addresses a
    // manual HTTP retry, and it lived outside the record the first version of
    // this guard read. Asserted by name so the coverage cannot silently narrow
    // again if havenTools is reshaped.
    const claude = toolDefinitionDescriptions(sdkClaudeTools)
    const authorize = claude.find(([name]) => name === 'authorize_x402_payment')
    expect(authorize, 'authorize_x402_payment missing from havenTools.claude').toBeDefined()
    expect(authorize![1]).toContain(V2_NAME)
    expect(authorize![1]).toContain(V1_NAME)
    expect(authorize![1]).toContain('manual HTTP retry')
  })

  it('the hosted plain-HTTP quote path — where the AGENT retries — names both', () => {
    // The specific surface the originating purchase used. Asserted by name
    // rather than left to the sweep, because this is the one that mattered.
    const quote = (hostedDescriptions as Record<string, string>).haven_pay_x402_quote
    expect(quote).toContain(V2_NAME)
    expect(quote).toContain(V1_NAME)
    expect(quote).toContain('retry the merchant YOURSELF')
  })
})
