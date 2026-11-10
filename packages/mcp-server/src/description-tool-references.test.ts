/**
 * #4796 (epic #4788 slice 4) — a tool description names only tools the agent
 * reading it can call.
 *
 * The local MCP (`@haven_ai/mcp`) and this hosted one build several
 * descriptions from shared text in the SDK, and they do not register the same
 * tools. Four descriptions told the agent to use a tool its own surface does
 * not have: the local `haven_send` and `haven_sweep_delegate` pointed at
 * `haven_check_funds` (hosted only), and the hosted `haven_send` and
 * `haven_pay_mcp_tool` pointed at `haven_pay_x402` (local only). An agent that
 * follows such a sentence calls a tool that is not in its list.
 *
 * For EACH surface this walks every registered tool's description, extracts
 * every `haven_…` tool name, and fails unless the name is one of:
 *   (a) a tool that surface registers;
 *   (b) a signer tool — taken from `@haven_ai/signer`'s own registry, not
 *       restated, because both surfaces hand signing to it;
 *   (c) an entry in `ALLOWED_REFERENCES`, keyed by surface, describing tool
 *       AND referenced name, with a reason.
 *
 * The key is all three on purpose. Keyed by referenced name alone, one
 * deliberate mention of `haven_pay_x402` on the hosted surface would excuse
 * every other hosted description that named it.
 *
 * Out of scope here, recorded on epic #4788: the SDK's own direct tool
 * definitions, the signer's descriptions, and backend response prose carry the
 * same class of reference.
 */
import { describe, expect, it } from 'vitest'
import { toolDescriptions as localToolDescriptions, toolSchemas as localToolSchemas } from '@haven_ai/mcp'
import { toolSchemas as signerToolSchemas } from '@haven_ai/signer'
import { toolDescriptions as hostedToolDescriptions, toolSchemas as hostedToolSchemas } from './tools/contracts.js'

type Surface = 'local' | 'hosted'

const SURFACES: Record<Surface, { registered: string[]; descriptions: Record<string, string> }> = {
  local: { registered: Object.keys(localToolSchemas), descriptions: localToolDescriptions as Record<string, string> },
  hosted: { registered: Object.keys(hostedToolSchemas), descriptions: hostedToolDescriptions as Record<string, string> },
}

const SIGNER_TOOLS = Object.keys(signerToolSchemas)

/**
 * A tool name, on a word boundary on both sides: `mcp__haven__haven_submit`
 * reads as `haven_submit`, never as `haven__haven_submit`, a name is never
 * cut short by a longer name that starts with it, and a trailing underscore
 * (markdown italics, `_haven_send_`) does not hide the name.
 */
const TOOL_NAME = /(?<![a-z0-9])haven_[a-z0-9]+(?:_[a-z0-9]+)*(?![a-z0-9]|_[a-z0-9])/g

const referencesIn = (text: string): string[] => [...new Set(text.match(TOOL_NAME) ?? [])]

/** Keyed `surface|describing tool|referenced name`. Each needs a reason. */
const ALLOWED_REFERENCES: Record<string, string> = {
  'hosted|haven_pay_x402_quote|haven_pay_x402':
    'Deliberate: the text says sub-budgets "pay only through the local MCP\'s haven_pay_x402 tools" — it names the other ' +
    'surface as the other surface, and it is true (the hosted tool takes no sub_budget_id; owner decision 2 on epic ' +
    '#3615, https://github.com/d-hinders/Haven-AI/issues/3615).',
}

/** Every reference a surface's descriptions make to a name it cannot resolve itself. */
function unresolved(surface: Surface): string[] {
  const { registered, descriptions } = SURFACES[surface]
  const out: string[] = []
  for (const tool of registered) {
    for (const name of referencesIn(descriptions[tool])) {
      if (registered.includes(name) || SIGNER_TOOLS.includes(name)) continue
      out.push(`${surface}|${tool}|${name}`)
    }
  }
  return out.sort()
}

describe('#4796 — a tool description names only tools its own surface can call', () => {
  it('scans every registered description on both surfaces, and the probes can say yes (anti-vacuity)', () => {
    for (const surface of ['local', 'hosted'] as const) {
      const { registered, descriptions } = SURFACES[surface]
      expect(registered.length, surface).toBeGreaterThan(0)
      // One description per registered tool: nothing is skipped for lack of a text.
      const scanned = registered.filter((tool) => typeof descriptions[tool] === 'string' && descriptions[tool].length > 0)
      expect(scanned.length, surface).toBe(registered.length)
    }
    // The signer registry is real, and its names are recognised as such.
    expect(SIGNER_TOOLS.length).toBeGreaterThan(0)
    expect(SIGNER_TOOLS).toContain('haven_sign')
    // The extractor finds a name that is there, whole, on a word boundary.
    expect(referencesIn('use haven_get_allowances, then mcp__haven__haven_submit.')).toEqual([
      'haven_get_allowances',
      'haven_submit',
    ])
    expect(referencesIn('haven_pay_x402_quote is not haven_pay_x402')).toEqual(['haven_pay_x402_quote', 'haven_pay_x402'])
    // A trailing underscore must not swallow the name (markdown italics).
    expect(referencesIn('see _haven_check_funds_ and haven_send_.')).toEqual(['haven_check_funds', 'haven_send'])
    // And real descriptions do name other tools — the scan is not reading empty text.
    expect(referencesIn(SURFACES.hosted.descriptions.haven_send)).toContain('haven_get_allowances')
    expect(referencesIn(SURFACES.local.descriptions.haven_send)).toContain('haven_get_allowances')
  })

  for (const surface of ['local', 'hosted'] as const) {
    it(`${surface}: every tool a description names is registered there, a signer tool, or an allowed reference`, () => {
      const allowed = Object.keys(ALLOWED_REFERENCES).filter((key) => key.startsWith(`${surface}|`)).sort()
      expect(
        unresolved(surface),
        `a ${surface} tool description names a tool the ${surface} surface does not register. Name a tool this ` +
          'surface has (see selectionGuidanceFor in the SDK tool-descriptions module), or add an ALLOWED_REFERENCES ' +
          'entry with a reason. Format: surface|describing tool|referenced name.',
      ).toEqual(allowed)
    })
  }

  it('every allowed reference carries a real reason and names a real surface and tool', () => {
    const entries = Object.entries(ALLOWED_REFERENCES)
    expect(entries.length).toBe(1)
    for (const [key, reason] of entries) {
      const [surface, tool, name] = key.split('|')
      expect(['local', 'hosted'], key).toContain(surface)
      expect(SURFACES[surface as Surface].registered, key).toContain(tool)
      // The referenced name must exist SOMEWHERE: an allowance for a name no
      // surface registers would be excusing a typo.
      expect([...SURFACES.local.registered, ...SURFACES.hosted.registered], key).toContain(name)
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(15)
      expect(reason, key).not.toMatch(/\b(todo|tbd|fixme|xxx)\b/i)
    }
  })

  it('no description on either surface names a tool that exists nowhere', () => {
    const everywhere = new Set([...SURFACES.local.registered, ...SURFACES.hosted.registered, ...SIGNER_TOOLS])
    for (const surface of ['local', 'hosted'] as const) {
      const { registered, descriptions } = SURFACES[surface]
      for (const tool of registered) {
        for (const name of referencesIn(descriptions[tool])) expect(everywhere, `${surface} ${tool} → ${name}`).toContain(name)
      }
    }
  })
})
