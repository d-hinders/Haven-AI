import { describe, expect, it } from 'vitest'
import { composeDescription, toolDescriptions } from './tool-descriptions.js'

describe('shared Haven tool descriptions', () => {
  it('routes allowance and budget questions to the allowance lookup', () => {
    const desc = composeDescription(toolDescriptions.getAllowances).toLowerCase()

    expect(desc).toContain('allowance')
    expect(desc).toContain('budget')
    expect(desc).toContain('spend limit')
    expect(desc).toContain('remaining amount')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('remaining budget')
    expect(desc).toContain('daily limit')
    expect(desc).toContain('reset period')
    expect(desc).toContain('what can i spend')
    expect(desc).toContain('what the agent can still spend')
  })

  it('routes transaction-history questions away from remaining-budget lookups', () => {
    const desc = composeDescription(toolDescriptions.listReceipts).toLowerCase()

    expect(desc).toContain('transaction history')
    expect(desc).toContain('payment evidence')
    expect(desc).toContain('use the allowance tool instead')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('what-can-i-spend')
  })

  it('routes read-only budget questions away from payment tools', () => {
    for (const key of ['payX402', 'payMpp'] as const) {
      const desc = composeDescription(toolDescriptions[key]).toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('what-can-i-spend')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })
})
