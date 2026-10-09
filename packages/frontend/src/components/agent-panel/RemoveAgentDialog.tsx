'use client'

import { useState } from 'react'
import type { Agent } from '@/hooks/useAgents'
import { useDelegationBudget } from '@/hooks/useDelegationBudget'
import { useDelegateBalance } from '@/hooks/useDelegateBalance'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { isHalfRevoked } from '@/lib/half-revoked'
// #3544: the credential revoke's refusal is read from the wire shape —
// status + `error_code` — never from the error's message text.
import { ApiRequestError } from '@/lib/api'
import Link from 'next/link'
import ConfirmDialog from '../ConfirmDialog'
import WalletConnectAction from '../WalletConnectAction'
import { ApprovalRequiredBanner } from '../haven/ApprovalRequiredBanner'
import { InlineAlert } from '../ui/InlineAlert'

/** Delegation rows `revoke-all` targets — the same set the backend counts as live. */
const LIVE_DELEGATION_STATUSES: ReadonlySet<string> = new Set(['pending', 'active', 'replaced'])

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
 *
 * #3542: the signature is decided from the agent's LIVE delegations, never from
 * `agent.status`. `POST /agents/:id/revoke` only flips the status — a revoked
 * (or archived) agent can still hold a redeemable budget, and skipping the
 * signature for it archived nothing and 409'd. `allowances` is no substitute: it
 * is projected from ACTIVE rows, so an agent whose only row is `replaced` looks
 * empty there and is still live. The dialog reads its own delegation list.
 *
 * `mode="finish"` is the half-revoked follow-up (#3542 D): the agent is already
 * revoked or archived and only the budget remains. It ends that budget, stops a
 * credential that is somehow still live, and never moves the agent between
 * lists or navigates anywhere.
 */
export function RemoveAgentDialog({
  agent,
  chainId = DEFAULT_CHAIN_ID,
  mode = 'remove',
  onRevokeCredential,
  onArchive,
  onBudgetEnded,
  onClose,
}: {
  agent: Agent
  chainId?: number
  mode?: 'remove' | 'finish'
  /** Called once the agent's budget is known to be ended (signed, or already none). */
  onBudgetEnded?: () => void
  /** POST /agents/:id/revoke via the caller's state (kills the API key). */
  onRevokeCredential: () => Promise<void>
  /** POST /agents/:id/archive via the caller's state (files under Removed). */
  onArchive: () => Promise<void>
  onClose: () => void
}) {
  const { revokeAll, ready, busy, budgets, budgetsError, signersError, signersLoading, hasPasskeys } = useDelegationBudget(agent.id, chainId)
  const { balance, hasRecoverableUsdc } = useDelegateBalance(agent.id)
  const [phase, setPhase] = useState<'confirm' | 'working' | 'filing_failed' | 'too_many'>('confirm')
  const [error, setError] = useState<string | null>(null)

  const finish = mode === 'finish'
  // Still loading: no verdict yet, so neither "sign" nor "already ended" is claimed.
  const budgetsLoading = budgets === null && !budgetsError
  // A failed read is unknown, not empty: stay on the signing path — `revokeAll`
  // treats the server's "nothing to revoke" as success without a signature.
  const hasLiveBudget =
    budgets === null || budgets.some((b) => LIVE_DELEGATION_STATUSES.has(b.status))
  // An unlinked agent's account is gone, and `revoke-all` refuses it. Do not
  // gate removing an already-revoked one behind a signature that can never be
  // collected; the card still marks its budget as one Haven cannot end here.
  const cannotEndBudgetHere = agent.account_id == null && agent.status === 'revoked'
  const needsSignature = hasLiveBudget && !cannotEndBudgetHere
  const budgetAlreadyEnded = budgets !== null && !hasLiveBudget

  // #3544: what the backend's credential-revoke refusal means for this flow.
  // The refusal is typed on the wire (404, or 409 with an `error_code`), so
  // the classification reads status and body — never the message text. The
  // old `/not found|already revoked/i` message match swallowed the real
  // refusal ("Agent not found or cannot be revoked" matched on "not found").
  // 404 stays step-already-done for the #1437 stale-tab race, but ONLY under
  // that race: status is not `revoked` here, so a 404 means another tab
  // revoked it between list load and now.
  function isCredentialStepAlreadyDone(err: unknown): boolean {
    if (!(err instanceof ApiRequestError)) return false
    if (err.status === 404) return true
    const code =
      typeof err.body === 'object' && err.body !== null && 'error_code' in err.body
        ? (err.body as { error_code?: unknown }).error_code
        : undefined
    return err.status === 409 && code === 'already_revoked'
  }

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
            ? finish
              ? 'The signature was cancelled — this agent’s budget is still active.'
              : 'The signature was cancelled — the agent was not removed and can still spend within its budget.'
            : result.reason === 'too_many'
              ? null // the state line below carries the actionable version
              : finish
                ? 'The budget could not be stopped — it is still active.'
                : 'The budget could not be stopped — the agent was not removed and can still spend within its budget.',
        )
        return
      }
    }
    // The budget is ended (signed now, or the list proved none was live). The
    // caller is told only AFTER the filing steps settle, whichever way they go:
    // a refetch fired earlier could land after the revoke/archive patches and
    // put stale status back on the card.
    const announceBudgetEnded = () => {
      if (!cannotEndBudgetHere) onBudgetEnded?.()
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
          if (!isCredentialStepAlreadyDone(err)) {
            throw err
          }
        }
      }
      // Finish never files the agent anywhere: an archived agent already is, and
      // a revoked one stays where the owner left it for an explicit Remove.
      if (!finish) await onArchive()
      announceBudgetEnded()
      onClose()
    } catch {
      announceBudgetEnded()
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
      title={finish ? `Finish revoking ${agent.name}?` : `Remove ${agent.name}?`}
      body={
        <div className="space-y-3">
          {finish ? (
            <>
              <p>
                {agent.status === 'revoked'
                  ? 'Haven already stopped this agent’s credential, but its budget is still active.'
                  : 'This agent is no longer in your list, but its budget is still active.'}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">Its remaining budget ends.</span>{' '}
                  {budgetsLoading
                    ? 'Checking which budgets it still holds…'
                    : budgetAlreadyEnded
                      ? 'No budget is left to end.'
                      : 'You sign once and every budget it still holds ends — no matter how many.'}
                </li>
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">Its history stays.</span> Nothing
                  moves, and you can still open every payment and record.
                </li>
              </ul>
            </>
          ) : (
          <>
              <p>Removing this agent does three things, in one step:</p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                <li>
                  <span className="font-medium text-[var(--v2-ink)]">It stops being able to spend.</span>{' '}
                  {budgetsLoading
                    ? 'Checking which budgets it still holds…'
                    : needsSignature
                      ? 'You sign once and every budget it holds ends — no matter how many.'
                      : cannotEndBudgetHere && isHalfRevoked(agent)
                        ? 'Haven cannot end its budget from here — it may still be active on the account it was removed from.'
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
          )}
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
            <div className="space-y-2">
              <p className="text-xs text-[var(--v2-ink-3)]">
                {/* #3845: never offer a passkey to an account that has none —
                    its only signer is the owner wallet. Unknown (null) keeps
                    the sentence that offers both. */}
                {hasPasskeys === false
                  ? 'Connect your account owner wallet to '
                  : 'Connect a wallet or use a passkey on this device to '}
                {finish ? 'end this budget' : 'remove this agent'}.
              </p>
              {/* #3812: revoking must never depend on the header — this is
                  the way out for an owner who signs with a browser wallet.
                  Not offered while the signer set is loading or failed to
                  load: connecting would not fix either. */}
              {!signersError && !signersLoading ? <WalletConnectAction /> : null}
            </div>
          )}
          {error && (
            <InlineAlert>{error}</InlineAlert>
          )}
          {phase === 'filing_failed' && (
            <InlineAlert>
              {finish
                ? 'The budget has ended, but the credential could not be stopped. Choose Finish revoking to retry.'
                : cannotEndBudgetHere
                  ? 'The agent could not be moved to Removed, and its budget may still be active on the account it was removed from.'
                  : 'The agent can no longer spend, but it could not be moved to Removed. Choose Finish removal to retry.'}
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
              , then {finish ? 'finish revoking' : 'remove it'}. Nothing changed — it can still spend until you do.
            </InlineAlert>
          )}
        </div>
      }
      confirmLabel={
        finish
          ? 'Finish revoking'
          : phase === 'filing_failed'
            ? 'Finish removal'
            : 'Remove agent'
      }
      tone="danger"
      loading={phase === 'working' || busy}
      confirmDisabled={needsSignature && !ready}
    />
  )
}
