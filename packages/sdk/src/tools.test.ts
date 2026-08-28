import { describe, expect, it } from 'vitest'
import { toolDescriptions as sharedDescriptions } from './tool-descriptions.js'
import { havenTools } from './tools.js'

describe('pre-built SDK tool definitions', () => {
  it('exposes get_allowances in Claude tool format', () => {
    const tools = havenTools.claude()
    const allowances = tools.find((tool) => tool.name === 'get_allowances')
    const makePayment = tools.find((tool) => tool.name === 'make_payment')

    expect(allowances).toBeDefined()
    expect(allowances?.input_schema).toEqual({
      type: 'object',
      properties: {},
      required: [],
    })
    expect(allowances?.description).toContain(sharedDescriptions.getAllowances.summary)
    expect(allowances?.description).toContain(sharedDescriptions.getAllowances.selectionGuidance)
    expect(makePayment?.description.toLowerCase()).toContain('use get_allowances instead')
  })

  it('exposes get_allowances in OpenAI tool format', () => {
    const tools = havenTools.openai()
    const allowances = tools.find((tool) => tool.function.name === 'get_allowances')
    const makePayment = tools.find((tool) => tool.function.name === 'make_payment')

    expect(allowances).toBeDefined()
    expect(allowances?.function.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
    })
    expect(allowances?.function.description).toContain(sharedDescriptions.getAllowances.summary)
    expect(allowances?.function.description).toContain(sharedDescriptions.getAllowances.selectionGuidance)
    expect(makePayment?.function.description.toLowerCase()).toContain('use get_allowances instead')
  })

  it('routes read-only budget questions away from direct payment tools', () => {
    const claudeTools = havenTools.claude()

    for (const name of ['authorize_x402_payment'] as const) {
      const desc = claudeTools.find((tool) => tool.name === name)?.description.toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('the allowance lookup tool is get_allowances')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })

  it('no longer advertises authorize_machine_payment (#1328: mpp_demo retired)', () => {
    const claudeNames = havenTools.claude().map((tool) => tool.name)
    const openaiNames = havenTools.openai().map((tool) => tool.function.name)

    expect(claudeNames).not.toContain('authorize_machine_payment')
    expect(openaiNames).not.toContain('authorize_machine_payment')
  })
})

describe('#2131: the hand-built descriptions in this file carry no dead resume trigger', () => {
  /**
   * The regression guard in `tool-descriptions.test.ts` iterates the SHARED
   * `toolDescriptions` object, which holds only four of the six tool-description
   * sites #2131 fixed. The other two — `AUTHORIZE_X402_DESCRIPTION` and
   * `RESUME_X402_DESCRIPTION` — are hand-built string literals in `tools.ts`,
   * outside that object, so nothing scanned them.
   *
   * haven-reviewer proved the gap by mutation: reintroducing the literal into
   * `AUTHORIZE_X402_DESCRIPTION` left the whole sdk suite green. A fix that
   * defends four of six sites against re-advertisement, in a PR whose entire
   * subject is an advertisement nobody caught, is the same defect one level up.
   *
   * Scans the ASSEMBLED tool definitions rather than the string constants, so a
   * new hand-built description is covered the moment it is registered.
   *
   * DELETE when #2145 gives `retry_original_x402_request` a reachable producer.
   */
  it('no assembled Claude or OpenAI tool description advertises retry_original_x402_request', () => {
    const described: Array<[string, string]> = [
      ...havenTools.claude().map((t) => [t.name, t.description] as [string, string]),
      ...havenTools.openai().map(
        (t) => [t.function.name, t.function.description] as [string, string],
      ),
    ]

    // Non-vacuity: an empty list would pass every assertion below.
    expect(described.length).toBeGreaterThan(0)

    for (const [name, description] of described) {
      expect(
        description,
        `${name} must not advertise retry_original_x402_request — nothing emits it (see #2145)`,
      ).not.toContain('retry_original_x402_request')
    }
  })
})
