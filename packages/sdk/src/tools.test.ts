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

    for (const name of ['authorize_x402_payment', 'authorize_machine_payment'] as const) {
      const desc = claudeTools.find((tool) => tool.name === name)?.description.toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('the allowance lookup tool is get_allowances')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })
})
