/**
 * #4808 — the SDK's own direct tool definitions name only tools the agent
 * reading them can call.
 *
 * `havenTools.claude()` and `havenTools.openai()` return exactly six tools:
 * `make_payment`, `get_payment_status`, `get_allowances`,
 * `authorize_x402_payment`, `resume_x402_payment` and `haven_sweep_delegate`.
 * Three of their descriptions used to name five `haven_…` names that are not
 * among the six — `haven_get_agent` (get_allowances), `haven_get_payment_status`
 * (authorize_x402_payment) and `haven_pay_x402` / `haven_get_allowances` /
 * `haven_check_funds` (haven_sweep_delegate). An agent that follows such a
 * sentence calls a tool that is not in its list.
 *
 * The extractor mirrors the `TOOL_NAME` pattern at
 * `packages/mcp-server/src/description-tool-references.test.ts:50` — copied,
 * not imported: the SDK cannot depend on `mcp-server`.
 */
import { describe, expect, it } from 'vitest'
import { toolDescriptions as sharedDescriptions } from './tool-descriptions.js'
import { havenTools } from './tools.js'

/**
 * A tool name, on a word boundary on both sides: `mcp__haven__haven_submit`
 * reads as `haven_submit`, never as `haven__haven_submit`. The greedy body
 * takes every `_segment`, so a name is never cut short by a longer name that
 * starts with it, and a trailing underscore (markdown italics,
 * `_haven_send_`) is left outside the name instead of hiding it.
 */
const TOOL_NAME = /(?<![a-z0-9])haven_[a-z0-9]+(?:_[a-z0-9]+)*/g

const referencesIn = (text: string): string[] => [...new Set(text.match(TOOL_NAME) ?? [])]

/** The six names `havenTools.claude()` and `havenTools.openai()` return. */
const SDK_TOOL_NAMES = [
  'make_payment',
  'get_payment_status',
  'get_allowances',
  'authorize_x402_payment',
  'resume_x402_payment',
  'haven_sweep_delegate',
] as const

interface ScannedDescription {
  format: 'claude' | 'openai'
  name: string
  description: string
}

function scannedDescriptions(): ScannedDescription[] {
  return [
    ...havenTools.claude().map((tool) => ({ format: 'claude' as const, name: tool.name, description: tool.description })),
    ...havenTools.openai().map((tool) => ({
      format: 'openai' as const,
      name: tool.function.name,
      description: tool.function.description,
    })),
  ]
}

describe('#4808 — an SDK tool description names only tools the SDK agent can call', () => {
  it('scans six descriptions per format, and the extractor finds a planted name (anti-vacuity)', () => {
    expect(havenTools.claude().map((tool) => tool.name)).toEqual([...SDK_TOOL_NAMES])
    expect(havenTools.openai().map((tool) => tool.function.name)).toEqual([...SDK_TOOL_NAMES])
    expect(scannedDescriptions()).toHaveLength(SDK_TOOL_NAMES.length * 2)

    // The extractor finds a name that is there, whole, on a word boundary.
    expect(referencesIn('use haven_get_allowances, then mcp__haven__haven_submit.')).toEqual([
      'haven_get_allowances',
      'haven_submit',
    ])
    expect(referencesIn('haven_pay_x402_quote is not haven_pay_x402')).toEqual(['haven_pay_x402_quote', 'haven_pay_x402'])
    // A trailing underscore must not swallow the name (markdown italics).
    expect(referencesIn('see _haven_check_funds_ and haven_send_.')).toEqual(['haven_check_funds', 'haven_send'])

    // And the extractor works on real repo prose: the shared fragment the SDK
    // variant is derived from still names an MCP tool, so a scan that finds
    // nothing in the SDK descriptions is a real answer, not a broken regex.
    expect(referencesIn(sharedDescriptions.getAllowances.behavior)).toContain('haven_get_agent')
    expect(referencesIn(sharedDescriptions.payX402.nextActionGuidance)).toContain('haven_get_payment_status')
    // Every description is real text — nothing is skipped for lack of one.
    for (const { format, name, description } of scannedDescriptions()) {
      expect(description.length, `${format}:${name}`).toBeGreaterThan(100)
    }
  })

  it('every haven_… name in a description is one of the six tools', () => {
    const allowed = new Set<string>(SDK_TOOL_NAMES)
    const offenders: string[] = []
    for (const { format, name, description } of scannedDescriptions()) {
      for (const reference of referencesIn(description)) {
        if (!allowed.has(reference)) offenders.push(`${format}|${name}|${reference}`)
      }
    }
    expect(
      offenders,
      'an SDK tool description names a tool the SDK agent cannot call. Name one of the six ' +
        '(get_payment_status, get_allowances, authorize_x402_payment, ...) or reword the sentence. ' +
        'Format: format|describing tool|referenced name.',
    ).toEqual([])
  })

  it('the two SDK-surface variants really differ from the shared text (a silent no-op would pass the scan)', () => {
    // The variants in tools.ts are derived from the shared fragments by a
    // string replacement. If a shared fragment is reworded so the replacement
    // stops matching, the SDK would serve the MCP text again — and the scan
    // above would catch the name, but this states the intent directly.
    const allowances = havenTools.claude().find((tool) => tool.name === 'get_allowances')
    expect(allowances?.description).not.toBe(
      [sharedDescriptions.getAllowances.summary, sharedDescriptions.getAllowances.selectionGuidance, sharedDescriptions.getAllowances.behavior, sharedDescriptions.getAllowances.nextActionGuidance]
        .filter(Boolean)
        .join(' '),
    )
    expect(allowances?.description).toContain('Open task budgets are not listed here.')

    const authorize = havenTools.claude().find((tool) => tool.name === 'authorize_x402_payment')
    expect(authorize?.description).toContain('a later get_payment_status reports')
    expect(authorize?.description).not.toContain('haven_get_payment_status')
  })
})
