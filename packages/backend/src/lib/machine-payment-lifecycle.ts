const MACHINE_PAYMENT_RAILS = new Set(['x402', 'mpp_demo', 'mpp_crypto', 'spt'])

export type MachinePaymentFlowStatus =
  | 'paid'
  | 'confirming_merchant'
  | 'needs_attention'

export type MachinePaymentAttentionReason =
  | 'merchant_retry_rejected_after_payment'

export interface MachinePaymentLifecycle {
  paymentFlowStatus: MachinePaymentFlowStatus | null
  paymentAttentionReason: MachinePaymentAttentionReason | null
}

export function machinePaymentLifecycle(input: {
  rail?: string | null
  paymentStatus?: string | null
  paymentProofStatus?: string | null
  reconciliationEventType?: string | null
}): MachinePaymentLifecycle {
  if (!input.rail || !MACHINE_PAYMENT_RAILS.has(input.rail)) {
    return { paymentFlowStatus: null, paymentAttentionReason: null }
  }
  if (input.paymentStatus && input.paymentStatus !== 'confirmed' && input.paymentStatus !== 'executed') {
    return { paymentFlowStatus: null, paymentAttentionReason: null }
  }

  if (input.reconciliationEventType === 'merchant_retry_rejected_after_payment') {
    return {
      paymentFlowStatus: 'needs_attention',
      paymentAttentionReason: 'merchant_retry_rejected_after_payment',
    }
  }

  if (
    input.paymentProofStatus === 'protocol_receipt_attached' ||
    input.paymentProofStatus === 'merchant_response_observed'
  ) {
    return { paymentFlowStatus: 'paid', paymentAttentionReason: null }
  }

  return { paymentFlowStatus: 'confirming_merchant', paymentAttentionReason: null }
}
