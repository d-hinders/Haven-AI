import { describe, expect, it } from 'vitest'
import { machinePaymentLifecycle } from '../machine-payment-lifecycle.js'

describe('machinePaymentLifecycle', () => {
  it('keeps unsettled protocol payments out of merchant lifecycle states', () => {
    expect(machinePaymentLifecycle({
      rail: 'x402',
      paymentStatus: 'pending_approval',
      paymentProofStatus: null,
      reconciliationEventType: null,
    })).toEqual({
      paymentFlowStatus: null,
      paymentAttentionReason: null,
    })
  })

  it('keeps successful merchant evidence visually quiet', () => {
    expect(machinePaymentLifecycle({
      rail: 'x402',
      paymentStatus: 'confirmed',
      paymentProofStatus: 'protocol_receipt_attached',
      reconciliationEventType: null,
    })).toEqual({
      paymentFlowStatus: 'paid',
      paymentAttentionReason: null,
    })
  })

  it('surfaces open merchant retry failures after payment', () => {
    expect(machinePaymentLifecycle({
      rail: 'mpp_demo',
      paymentStatus: 'executed',
      paymentProofStatus: 'payment_confirmed',
      reconciliationEventType: 'merchant_retry_rejected_after_payment',
    })).toEqual({
      paymentFlowStatus: 'needs_attention',
      paymentAttentionReason: 'merchant_retry_rejected_after_payment',
    })
  })
})
