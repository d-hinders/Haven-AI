import type { StatusTone } from '@/components/ui/StatusBadge'

export type AgentStatus = 'active' | 'paused' | 'pending_approval' | 'revoked'

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'proposed'
  | 'rejected'
  | 'executed'
  | 'expired'

export type PaymentStatus =
  | 'pending_signature'
  | 'pending_approval'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'

export interface StatusPresentation {
  label: string
  tone: StatusTone
}

const AGENT_STATUS: Record<AgentStatus, StatusPresentation> = {
  active: { label: 'Connected', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  // #1069: setup started but no budget granted yet — the agent exists and is
  // reachable, it just cannot pay. Warning, not danger: the fix is one step.
  pending_approval: { label: 'Needs setup', tone: 'warning' },
  revoked: { label: 'Revoked', tone: 'danger' },
}

const APPROVAL_STATUS: Record<ApprovalStatus, StatusPresentation> = {
  pending: { label: 'Needs approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'brand' },
  proposed: { label: 'Submitted', tone: 'brand' },
  rejected: { label: 'Rejected', tone: 'danger' },
  executed: { label: 'Sent', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
}

const PAYMENT_STATUS: Record<PaymentStatus, StatusPresentation> = {
  pending_signature: { label: 'Awaiting signature', tone: 'brand' },
  pending_approval: { label: 'Needs approval', tone: 'warning' },
  submitted: { label: 'Submitted', tone: 'brand' },
  confirmed: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
}

export function formatUnknownStatus(status: string): string {
  const words = status
    .split('_')
    .filter(Boolean)
    .map((part) => part.toLowerCase())

  if (words.length === 0) return 'Unknown'
  const [first, ...rest] = words
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

export function agentStatusPresentation(status: string): StatusPresentation {
  return AGENT_STATUS[status as AgentStatus] ?? {
    label: formatUnknownStatus(status),
    tone: 'neutral',
  }
}

export function approvalStatusPresentation(status: string): StatusPresentation {
  return APPROVAL_STATUS[status as ApprovalStatus] ?? {
    label: formatUnknownStatus(status),
    tone: 'neutral',
  }
}

export function paymentStatusPresentation(status: string): StatusPresentation {
  return PAYMENT_STATUS[status as PaymentStatus] ?? {
    label: formatUnknownStatus(status),
    tone: 'neutral',
  }
}

export function activityStatusPresentation(status: string): StatusPresentation {
  if (status in APPROVAL_STATUS) return approvalStatusPresentation(status)
  return paymentStatusPresentation(status)
}

export function isActionableApprovalStatus(status: string): boolean {
  return status === 'pending' || status === 'approved'
}

export function failedOrRejectedStatus(status: string): boolean {
  return status === 'failed' || status === 'rejected'
}
