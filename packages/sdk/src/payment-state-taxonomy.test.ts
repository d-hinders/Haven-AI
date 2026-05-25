import { describe, expect, it } from 'vitest'
import {
  AgentPaymentNextAction,
  AgentPaymentNextActionSchema,
  AgentPaymentPhase,
  AgentPaymentPhaseSchema,
  AgentPaymentRail,
  AgentPaymentRailSchema,
} from './index.js'

describe('agent payment state taxonomy', () => {
  it('exports schema fragments with every phase, next action, and rail value', () => {
    expect(AgentPaymentPhaseSchema.enum).toContain(AgentPaymentPhase.UserApprovalRequired)
    expect(AgentPaymentPhaseSchema['x-enumDescriptions'][AgentPaymentPhase.FundingSent])
      .toContain('merchant/protocol leg')

    expect(AgentPaymentNextActionSchema.enum).toContain(AgentPaymentNextAction.RetryOriginalX402Request)
    expect(AgentPaymentNextActionSchema['x-enumDescriptions'][AgentPaymentNextAction.WaitForUserApproval])
      .toContain('wallet owner')

    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.Direct)
    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.X402)
    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.Mpp)
  })
})
