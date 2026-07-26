/**
 * Machine-payment lifecycle — domain moved verbatim to `@haven_ai/core`
 * (#987) so the frontend maps the same unions instead of restating them.
 * This shim keeps the backend's import path stable.
 */
export {
  machinePaymentLifecycle,
  MACHINE_PAYMENT_RAILS,
  type MachinePaymentFlowStatus,
  type MachinePaymentAttentionReason,
  type MachinePaymentLifecycle,
} from '@haven_ai/core'
