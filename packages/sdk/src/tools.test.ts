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

describe('#2145: the hand-built resume description in this file gates on the live trigger', () => {
  /**
   * The regression guard in `tool-descriptions.test.ts` iterates the SHARED
   * `toolDescriptions` object, which holds only four of the six tool-description
   * sites #2131 touched. The other two — `AUTHORIZE_X402_DESCRIPTION` and
   * `RESUME_X402_DESCRIPTION` — are hand-built string literals in `tools.ts`,
   * outside that object, so nothing else scans them.
   *
   * #2145 gave `retry_original_x402_request` a real producer
   * (agent-payment-status.ts). The assembled `resume_x402_payment` tool
   * description must name it as the gate, and no OTHER assembled description
   * should still claim the trigger is unreachable.
   *
   * Scans the ASSEMBLED tool definitions rather than the string constants, so
   * a new hand-built description is covered the moment it is registered.
   */
  it('resume_x402_payment names retry_original_x402_request as its gate; nothing claims it is unreachable', () => {
    const described: Array<[string, string]> = [
      ...havenTools.claude().map((t) => [t.name, t.description] as [string, string]),
      ...havenTools.openai().map(
        (t) => [t.function.name, t.function.description] as [string, string],
      ),
    ]

    // Non-vacuity: an empty list would pass every assertion below.
    expect(described.length).toBeGreaterThan(0)

    const resumeDescs = described.filter(([name]) => name === 'resume_x402_payment')
    expect(resumeDescs.length).toBeGreaterThan(0)
    for (const [, description] of resumeDescs) {
      expect(description).toContain('nextAction=retry_original_x402_request')
    }

    for (const [name, description] of described) {
      const lower = description.toLowerCase()
      expect(
        lower,
        `${name} must not claim retry_original_x402_request is unreachable — #2145 gave it a producer`,
      ).not.toContain('not currently reachable')
      expect(
        lower,
        `${name} must not claim nothing emits a resume trigger — #2145 gave it a producer`,
      ).not.toContain('nothing emits')
    }
  })
})
