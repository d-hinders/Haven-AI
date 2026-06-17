import { describe, expect, it } from 'vitest'
import {
  AgentPaymentNextAction,
  AgentPaymentNextActionSchema,
  AgentPaymentFailureCode,
  AgentPaymentFailureCodeSchema,
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
    expect(AgentPaymentNextActionSchema.enum).toContain(AgentPaymentNextAction.PaymentWindowExpired)
    expect(AgentPaymentNextActionSchema['x-enumDescriptions'][AgentPaymentNextAction.WaitForUserApproval])
      .toContain('wallet owner')
    expect(AgentPaymentNextActionSchema['x-enumDescriptions'][AgentPaymentNextAction.PaymentWindowExpired])
      .toContain('same idempotency key')

    expect(AgentPaymentFailureCodeSchema.enum).toContain(AgentPaymentFailureCode.PriceExceedsMax)
    expect(AgentPaymentFailureCodeSchema.enum).toContain(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(AgentPaymentFailureCodeSchema.enum).toContain(AgentPaymentFailureCode.MerchantRejectedAfterFunding)
    expect(AgentPaymentFailureCodeSchema['x-enumDescriptions'][AgentPaymentFailureCode.PriceExceedsMax])
      .toContain('max_amount')
    expect(AgentPaymentFailureCodeSchema['x-enumDescriptions'][AgentPaymentFailureCode.MerchantRejectedAfterFunding])
      .toContain('haven_sweep_delegate')

    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.Direct)
    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.X402)
    expect(AgentPaymentRailSchema.enum).toContain(AgentPaymentRail.Mpp)
  })
})
