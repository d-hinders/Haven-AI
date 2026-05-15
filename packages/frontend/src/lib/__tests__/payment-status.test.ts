import { describe, expect, it } from 'vitest'
import {
  activityStatusPresentation,
  agentStatusPresentation,
  approvalStatusPresentation,
  failedOrRejectedStatus,
  formatUnknownStatus,
  isActionableApprovalStatus,
  paymentStatusPresentation,
} from '../payment-status'

describe('payment status presentation', () => {
  it('maps approval states to product labels and tones', () => {
    expect(approvalStatusPresentation('pending')).toEqual({
      label: 'Needs approval',
      tone: 'warning',
    })
    expect(approvalStatusPresentation('proposed')).toEqual({
      label: 'Submitted',
      tone: 'brand',
    })
    expect(approvalStatusPresentation('executed')).toEqual({
      label: 'Sent',
      tone: 'success',
    })
  })

  it('maps payment and SDK-facing states consistently', () => {
    expect(paymentStatusPresentation('pending_approval')).toEqual({
      label: 'Needs approval',
      tone: 'warning',
    })
    expect(paymentStatusPresentation('pending_signature')).toEqual({
      label: 'Awaiting signature',
      tone: 'brand',
    })
    expect(paymentStatusPresentation('expired')).toEqual({
      label: 'Expired',
      tone: 'neutral',
    })
  })

  it('maps agent status copy for product surfaces', () => {
    expect(agentStatusPresentation('active')).toEqual({
      label: 'Connected',
      tone: 'success',
    })
    expect(agentStatusPresentation('revoked')).toEqual({
      label: 'Revoked',
      tone: 'danger',
    })
  })

  it('keeps unknown statuses readable instead of exposing snake case', () => {
    expect(formatUnknownStatus('waiting_for_owner')).toBe('Waiting for owner')
    expect(activityStatusPresentation('waiting_for_owner')).toEqual({
      label: 'Waiting for owner',
      tone: 'neutral',
    })
  })

  it('centralizes actionable and failure checks', () => {
    expect(isActionableApprovalStatus('pending')).toBe(true)
    expect(isActionableApprovalStatus('approved')).toBe(true)
    expect(isActionableApprovalStatus('proposed')).toBe(false)
    expect(failedOrRejectedStatus('failed')).toBe(true)
    expect(failedOrRejectedStatus('rejected')).toBe(true)
    expect(failedOrRejectedStatus('expired')).toBe(false)
  })
})
