import { describe, expect, it } from 'vitest'
import { machinePaymentLifecyclePresentation } from '../machine-payment-lifecycle'

describe('machinePaymentLifecyclePresentation', () => {
  it('keeps paid machine payments visually quiet', () => {
    expect(machinePaymentLifecyclePresentation({ paymentFlowStatus: 'paid' })).toBeNull()
    expect(machinePaymentLifecyclePresentation({ paymentFlowStatus: null })).toBeNull()
  })

  it('surfaces incomplete or rejected merchant flows', () => {
    expect(machinePaymentLifecyclePresentation({ paymentFlowStatus: 'confirming_merchant' })).toEqual({
      label: 'Confirming',
      tone: 'warning',
    })
    expect(machinePaymentLifecyclePresentation({ paymentFlowStatus: 'needs_attention' })).toEqual({
      label: 'Needs attention',
      tone: 'warning',
    })
  })
})
