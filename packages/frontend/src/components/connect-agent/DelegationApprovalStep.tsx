'use client'

import { useState } from 'react'
import { type Address } from 'viem'
import { api } from '@/lib/api'
import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import { useDelegationBudget, type GrantInput } from '@/hooks/useDelegationBudget'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { budgetPeriodLabel } from '@/lib/budget-period'
import BudgetGrantAction from '../BudgetGrantAction'
import WalletButton from '../WalletButton'
import { Button } from '../ui/Button'
import { AgentRulesSummary } from '../haven'
import { ConnectionVerificationFooter } from './ConnectionVerificationFooter'
import { WarningCallout } from './SetupNotices'

/**
 * Step 4 on the DELEGATION rail (#1073).
 *
 * Same step, same position in the stepper, same summary-then-approve shape as
 * the legacy `LocalConnectionReady` — only the instrument differs: a passkey
 * or owner signature over the budget instead of a Safe transaction. The user
 * approves where the rules are shown, and never leaves the modal to do it.
 *
 * The budget was already chosen at the policy step, so nothing is re-entered
 * here; this screen restates it and takes the signature.
 */
export function DelegationApprovalStep({
  agentId,
  setupId,
  chainId,
  status,
  walletName,
  onApproved,
  onCancel,
  onClose,
  isWrongChain,
  approvalChainName,
  onSwitchChain,
  isSwitchingChain,
}: {
  agentId: string
  setupId: string
  chainId: number
  status: AgentConnectionSetupStatusResponse
  walletName: string
  onApproved: () => Promise<void>
  onCancel: () => void
  onClose: () => void
  /** True when a wallet is connected but to the wrong chain for this account. */
  isWrongChain: boolean
  approvalChainName: string
  onSwitchChain: () => void
  isSwitchingChain: boolean
}) {
  const { grant, busy, ready } = useDelegationBudget(agentId, chainId)
  const [confirming, setConfirming] = useState(false)
  const [confirmFailed, setConfirmFailed] = useState(false)
  // Once the budget is signed the agent is live and spending — there is
  // nothing left for "Cancel setup" to undo, and offering it would promise a
  // reversal Haven cannot perform (#1073 review). The backend refuses it too.
  const [granted, setGranted] = useState(false)

  const budget = status.agent_budget[0] ?? null
  const displayAmount = budget
    ? formatAllowanceForToken(budget.allowance_amount, chainId, budget.token_symbol)
    : null

  // The policy step's single budget, in the shape the grant takes. Minutes on
  // the setup record, seconds on a delegation.
  const grantInput: GrantInput | null = budget
    ? {
        tokenAddress: budget.token_address as Address,
        // Unpinned by design: a recipient-pinned budget cannot fund the agent
        // wallet, which would lock the agent out of the standard x402 path.
        // Pinning stays a deliberate choice on the agent's page.
        recipientAddress: null,
        budgetAtomic: budget.allowance_amount,
        periodSeconds: budget.reset_period_min * 60,
      }
    : null

  async function confirmWithHaven() {
    setGranted(true)
    setConfirming(true)
    setConfirmFailed(false)
    try {
      // Haven verifies the signed budget itself — this asserts nothing and is
      // safe to retry.
      await api.post(`/agent-connection-setups/${encodeURIComponent(setupId)}/budget-approval`, {})
      await onApproved()
    } catch {
      setConfirmFailed(true)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <AgentRulesSummary
        title="Approve agent rules"
        description={`You sign once to give ${status.agent.name ?? 'this agent'} authority to spend within this budget. It refills every period, and nothing executes outside what you approve here.`}
        density="compact"
        items={[
          {
            label: 'Agent name',
            value: status.agent.name ?? 'New agent',
            helper: status.agent.description?.trim() || undefined,
          },
          { label: 'Spend from', value: walletName },
          {
            label: 'Budget',
            value: displayAmount ? (
              `${displayAmount} ${budget?.token_symbol} ${budgetPeriodLabel(budget?.reset_period_min ?? 0)}`
            ) : (
              <span className="text-[var(--v2-ink-3)]">Waiting for budget</span>
            ),
          },
        ]}
        footer={
          <ConnectionVerificationFooter
            delegateAddress={status.delegate_address ?? null}
            install={status.install_status}
          />
        }
      />

      {confirmFailed && (
        <WarningCallout
          title="Budget set — finishing up"
          body={
            <>
              Your budget is approved and the agent can spend within it. Haven just could not finish
              marking this setup complete.
            </>
          }
        >
          <Button variant="ghost" size="sm" onClick={confirmWithHaven} disabled={confirming} className="mt-3 w-full">
            {confirming ? 'Finishing…' : 'Try again'}
          </Button>
        </WarningCallout>
      )}

      {confirmFailed ? (
        <div className="flex gap-3">
          {/* The budget is signed and the agent is live. Closing is all that
              is left — to stop it, the user pauses or revokes it on its own
              page. Offering "Cancel setup" here would promise a reversal
              Haven cannot perform. */}
          <Button variant="ghost" onClick={onClose} disabled={confirming} className="flex-1">
            Close
          </Button>
        </div>
      ) : (
        <BudgetGrantAction
          grant={grant}
          busy={busy || confirming}
          ready={ready}
          input={grantInput}
          label="Approve budget"
          busyLabel={confirming ? 'Finishing…' : 'Waiting for signature…'}
          // Same footer shape as the legacy step: equal-width ghost-then-
          // primary, with the money-authority action carrying the weight.
          leadingAction={
            granted ? (
              <Button variant="ghost" onClick={onClose} disabled={confirming} className="flex-1">
                Close
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={onCancel}
                disabled={busy || confirming}
                className="flex-1"
              >
                Cancel setup
              </Button>
            )
          }
          notReadyHint={
            isWrongChain
              ? `This Haven wallet is on ${approvalChainName}. Switch networks to approve the budget.`
              : 'Connect the wallet that owns this Haven wallet to approve the budget.'
          }
          // A passkey account is always ready. An EOA-owned one is blocked for
          // one of two different reasons, and the legacy step distinguishes
          // them — offer the SAME two exits rather than a generic connect
          // button that a wrong-network user cannot act on.
          notReadyAction={
            isWrongChain ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onSwitchChain}
                disabled={isSwitchingChain}
                className="w-full"
              >
                {isSwitchingChain ? 'Switching network…' : `Switch to ${approvalChainName}`}
              </Button>
            ) : (
              <WalletButton />
            )
          }
          onGranted={confirmWithHaven}
        />
      )}
    </>
  )
}
