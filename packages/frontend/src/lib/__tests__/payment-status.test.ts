import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentStatusPresentation,
  failedOrRejectedStatus,
  formatUnknownStatus,
  paymentStatusPresentation,
} from '../payment-status'

/**
 * Every value `payment_intents.status` is ever written to, enumerated from the
 * backend's write sites (`infra/repositories/payment-intents.ts`,
 * `x402-authorizations.ts`, `agent-rekeys.ts`). This is the complete input
 * domain for `paymentStatusPresentation` on an activity row.
 */
const REACHABLE_PAYMENT_STATUSES = [
  'pending_signature',
  'submitted',
  'confirmed',
  'failed',
  'expired',
] as const

/** Statuses the retired approval queue used to mint. None is reachable now. */
const RETIRED_APPROVAL_STATUSES = [
  'pending',
  'pending_approval',
  'approved',
  'proposed',
  'rejected',
  'executed',
] as const

describe('payment status presentation', () => {
  it('maps every reachable payment status to a product label and tone', () => {
    expect(
      Object.fromEntries(REACHABLE_PAYMENT_STATUSES.map((s) => [s, paymentStatusPresentation(s)])),
    ).toEqual({
      pending_signature: { label: 'Awaiting signature', tone: 'brand' },
      submitted: { label: 'Submitted', tone: 'brand' },
      confirmed: { label: 'Sent', tone: 'success' },
      failed: { label: 'Failed', tone: 'danger' },
      expired: { label: 'Expired', tone: 'neutral' },
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
    // The AGENT `pending_approval` is alive (#1069) and must keep saying
    // "Needs setup" — it is a different field from the retired payment queue,
    // and #2120 must not have collapsed the two.
    expect(agentStatusPresentation('pending_approval')).toEqual({
      label: 'Needs setup',
      tone: 'warning',
    })
  })

  it('keeps unknown statuses readable instead of exposing snake case', () => {
    expect(formatUnknownStatus('waiting_for_owner')).toBe('Waiting for owner')
    expect(paymentStatusPresentation('waiting_for_owner')).toEqual({
      label: 'Waiting for owner',
      tone: 'neutral',
    })
  })

  it('centralizes the failure check', () => {
    expect(failedOrRejectedStatus('failed')).toBe(true)
    expect(failedOrRejectedStatus('expired')).toBe(false)
    // The `'rejected'` arm is approval-era residue that #2120 deliberately
    // KEPT (see the module header's "Deliberately left" note). A decision
    // with no guard is not a decision — remove or rename the arm and this
    // goes red, instead of AgentDetailClient's error tinting changing
    // silently for a status that cannot arrive.
    expect(failedOrRejectedStatus('rejected')).toBe(true)
  })

  /**
   * #2120 — the guard on the decision this module records.
   *
   * The approval presentation was deleted because nothing can reach it, and
   * because what it rendered ("Needs approval") promised a queue that no
   * longer exists on any rail. Putting any of it back must fail here rather
   * than quietly reappearing in a design-review capture.
   */
  describe('the retired approval presentation cannot come back (#2120)', () => {
    it('gives every retired approval status a neutral echo, never a promise', () => {
      for (const status of RETIRED_APPROVAL_STATUSES) {
        const { label, tone } = paymentStatusPresentation(status)
        // Fail-closed: the module says what the backend said, and claims
        // nothing about anyone being able to act on it.
        expect({ status, label, tone }).toEqual({
          status,
          label: formatUnknownStatus(status),
          tone: 'neutral',
        })
        // The echo may still contain the word ("Pending approval" is what
        // the backend called it); what must never come back is the PROMISE —
        // an actionable label on a queue nobody can act on.
        expect(label).not.toBe('Needs approval')
        expect(tone).not.toBe('warning')
      }
    })

    it('carries no approval-queue copy or export in the module source', () => {
      // The label was the product promise; the exports were its plumbing.
      // A source-level assertion is the only thing that catches a re-added
      // export nobody calls yet — exactly how `isActionableApprovalStatus`
      // survived with zero call sites until #2120.
      const source = readFileSync(path.join(__dirname, '..', 'payment-status.ts'), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(code).not.toMatch(/Needs approval/)
      expect(code).not.toMatch(/approvalStatusPresentation|isActionableApprovalStatus|APPROVAL_STATUS|ApprovalStatus/)
    })
  })
})
