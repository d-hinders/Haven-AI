'use client'

import { useState } from 'react'
import type { Agent } from '@/hooks/useAgents'
import { useDelegationBudget } from '@/hooks/useDelegationBudget'
import { useDelegateBalance } from '@/hooks/useDelegateBalance'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import Link from 'next/link'
import ConfirmDialog from '../ConfirmDialog'
import { ApprovalRequiredBanner } from '../haven/ApprovalRequiredBanner'
import { InlineAlert } from '../ui/InlineAlert'

/**
 * #1402: "Remove agent" — ONE action with three effects, in an order that is
 * honest about partial failure:
 *
 *   1. Revoke every budget delegation on-chain — one signature (#1400).
 *      If this fails or is rejected, STOP: nothing else happens, and the
 *      error says the agent was NOT removed. (A dead credential next to a
 *      live on-chain budget is the state nobody should be able to create.)
 *   2. Revoke the agent — the credential stops working immediately.
 *   3. Archive (#1401) — the agent moves to Removed; history stays readable.
 *
 * Retry-safety: a remove that failed at step 2/3 leaves the agent revoked
 * (and visibly un-archived in the primary list). Re-running skips what is
 * already done — revoke-all reports "nothing to revoke" as success, and the
 * status check skips the credential step.
 *
 * The delegate-balance warning (#1403) is information, never a gate: a slow
 * or failing read degrades to no warning, and Remove stays available.
 */
export function RemoveAgentDialog({
  agent,
  chainId = DEFAULT_CHAIN_ID,
  onRevokeCredential,
  onArchive,
  onClose,
}: {
  agent: Agent
  chainId?: number
  /** POST /agents/:id/revoke via the caller's state (kills the API key). */
  onRevokeCredential: () => Promise<void>
  /** POST /agents/:id/archive via the caller's state (files under Removed). */
  onArchive: () => Promise<void>
  onClose: () => void
}) {
  const { revokeAll, ready, busy } = useDelegationBudget(agent.id, chainId)
  const { balance, hasRecoverableUsdc } = useDelegateBalance(agent.id)
  const [phase, setPhase] = useState<'confirm' | 'working' | 'filing_failed' | 'too_many'>('confirm')
  const [error, setError] = useState<string | null>(null)

  const needsSignature = agent.status !== 'revoked'

  async function handleRemove() {
    setError(null)
    setPhase('working')

    // Step 1 — the one that can fail without consequence: budgets die first.
    if (needsSignature) {
      const result = await revokeAll()
      if (!result.ok) {
        setPhase(result.reason === 'too_many' ? 'too_many' : 'confirm')
        setError(
          result.reason === 'cancelled'
            ? 'The signature was cancelled — the agent was not removed and can still spend within its budget.'
            : result.reason === 'too_many'
              ? null // the state line below carries the actionable version
              : 'The budget could not be stopped — the agent was not removed and can still spend within its budget.',
        )
        return
      }
    }

    // Steps 2–3 — the budget is already dead; a failure here only leaves the
    // filing unfinished (agent visible as revoked in the primary list).
    try {
      if (agent.status !== 'revoked') {
        // #1437: another tab may have revoked this agent since the list was
        // loaded, which makes `agent.status` stale and this call 404. That is
        // step-already-done, not a failure — the same semantics revoke-all's
        // 409 already has. Aborting here used to strand the retry forever,
        // because the retry re-read the same stale prop and archive (which
        // WOULD have succeeded) was sequenced after the failing call.
        try {
          await onRevokeCredential()
        } catch (err) {
          if (!/not found|already revoked/i.test(err instanceof Error ? err.message : '')) {
            throw err
          }
        }
      }
      await onArchive()
      onClose()
    } catch {
      // Deliberately NOT err.message: api.ts throws the backend's raw error
      // string, and this is a destructive-flow dialog — the state line below
      // says what happened and what to do next.
      setPhase('filing_failed')
      setError(null)
    }
  }

  return (
    <ConfirmDialog
      open
      onCancel={onClose}
      onConfirm={handleRemove}
      title={`Remove ${agent.name}?`}
      body={
        <div className="space-y-3">
          <>
              <p>Removing this agent does three things, in one step:</p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">It stops being able to spend.</span>{' '}
                  {needsSignature
                    ? 'You sign once and every budget it holds ends — no matter how many.'
                    : 'Its spending authority is already ended.'}
                </li>
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">Its credential stops working</span>{' '}
                  immediately — tools and API access end with it.
                </li>
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">Its history stays.</span> The agent
                  moves to Removed, where every payment and record remains readable. You can restore it
                  to the list later, but restoring never brings back its ability to spend.
                </li>
              </ul>
          </>
          {hasRecoverableUsdc && balance && (
            <ApprovalRequiredBanner
              title="This agent's wallet still holds funds"
              tone="warning"
              density="compact"
            >
              {balance.usdc} USDC can be recovered.{' '}
              <Link
                href={`/agents/${agent.id}/sweep`}
                className="text-[var(--v2-brand)] underline-offset-2 hover:underline"
              >
                Sweep funds first
              </Link>{' '}
              — or remove now and sweep later; removal never blocks recovery.
            </ApprovalRequiredBanner>
          )}
          {needsSignature && !ready && (
            <p className="text-xs text-[var(--v2-ink-3)]">
              Connect a wallet or use a passkey on this device to remove this agent.
            </p>
          )}
          {error && (
            <InlineAlert>{error}</InlineAlert>
          )}
          {phase === 'filing_failed' && (
            <InlineAlert>
              The agent can no longer spend, but it could not be moved to Removed. Choose
              Finish removal to retry.
            </InlineAlert>
          )}
          {/* #1437: the backend refuses an oversized batch by naming the
              remedy; repeating "the budget could not be stopped" would leave
              the user pressing the same button forever. */}
          {phase === 'too_many' && (
            <InlineAlert>
              This agent holds too many budgets to stop in one signature. Stop them individually
              on the{' '}
              <Link
                href={`/agents/${agent.id}`}
                className="text-[var(--v2-brand)] underline-offset-2 hover:underline"
              >
                agent&apos;s budget card
              </Link>
              , then remove it. Nothing changed — it can still spend until you do.
            </InlineAlert>
          )}
        </div>
      }
      confirmLabel={
        phase === 'filing_failed' ? 'Finish removal' : 'Remove agent'
      }
      tone="danger"
      loading={phase === 'working' || busy}
      confirmDisabled={needsSignature && !ready}
    />
  )
}
