'use client'

import Link from 'next/link'
import { useState } from 'react'
import { type Address } from 'viem'
import { api } from '@/lib/api'
import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import { useDelegationBudget, type GrantInput } from '@/hooks/useDelegationBudget'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { BUDGET_END_DEFAULT_DAYS, budgetEndsAt } from '@/lib/budget-end'
import BudgetGrantAction from '../BudgetGrantAction'
import BudgetEndDateSelect from '../haven/BudgetEndDateSelect'
import PasskeyElsewhereHint from '../PasskeyElsewhereHint'
import WalletButton from '../WalletButton'
import { Button } from '../ui/Button'
import { AgentRulesSummary } from '../haven'
import { ConnectionVerificationFooter } from './ConnectionVerificationFooter'
import { ROW_FOOTER_OUTDENT_CLASS } from './ConnectSteps'
import { WarningCallout } from './SetupNotices'

/**
 * Step 3 on the DELEGATION rail (#1073).
 *
 * Same step, same position in the stepper, same summary-then-approve shape as
 * the retired legacy Safe approval step — only the instrument differs: a passkey
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
  accountId,
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
  /** The account the budget is approved on; the wallet pill reports its signer. */
  accountId?: string | null
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
  const { grant, busy, ready, passkeyElsewhere } = useDelegationBudget(agentId, chainId)
  const [confirming, setConfirming] = useState(false)
  const [confirmFailed, setConfirmFailed] = useState(false)
  // Once the budget is signed the agent is live and spending — there is
  // nothing left for "Cancel" to undo, and offering it would promise a
  // reversal Haven cannot perform (#1073 review). The backend refuses it too.
  const [granted, setGranted] = useState(false)
  // #4350: the end date is a CHOICE on this step — 30/90/180/365 days, 90 the
  // default (owner decision 1 on #4349). Until this slice the connect approval
  // showed no end date at all; the owner now picks one and reads its date
  // before the signature. Renewal later is the edit flow's new end date.
  const [endDays, setEndDays] = useState(BUDGET_END_DEFAULT_DAYS)
  const nowSec = Math.floor(Date.now() / 1000)

  const budget = status.agent_budget[0] ?? null
  const displayAmount = budget
    ? formatAllowanceForToken(budget.allowance_amount, chainId, budget.token_symbol)
    : null

  // The policy step's single budget, in the shape the grant takes. Minutes on
  // the setup record, seconds on a delegation.
  const endsAt = budget ? budgetEndsAt(endDays, nowSec) : null
  const grantInput: GrantInput | null = budget
    ? {
        tokenAddress: budget.token_address as Address,
        // Unpinned by design: a recipient-pinned budget cannot fund the agent
        // wallet, which would lock the agent out of the standard x402 path.
        // Pinning stays a deliberate choice on the agent's page.
        recipientAddress: null,
        budgetAtomic: budget.allowance_amount,
        periodSeconds: budget.reset_period_min * 60,
        // #4350: the chosen end date rides the build — a surface that shows
        // one must never drop the field (the server default would silently
        // replace it).
        ...(endsAt !== null ? { expiresAt: endsAt } : {}),
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
        // #1684: no card heading — the modal subtitle already reads "Approve
        // the agent budget" above this card, and since #3832 the step-list
        // row around it says "Review and approve". One sentence, once.
        title={null}
        // #1684: one line, not three sentences. What the table below cannot
        // say is kept: the refill, and the guarantee that nothing executes
        // outside this budget — the only statement of it anywhere in the
        // flow, on the screen that grants spend authority. The per-period
        // amount is dropped because the Budget row already carries it.
        description={`You approve once to give ${status.agent.name ?? 'this agent'} a budget that refills every period — nothing executes outside it.`}
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
            connectorPackage={status.connector_package}
          />
        }
      />

      {budget ? (
        // #4350: the end-date choice, with its resulting day — the same
        // control the agent page's grant form and the edit modal use. The
        // summary above restates the policy; this chooses the budget's term.
        <div className="mt-4">
          <BudgetEndDateSelect
            id="approval-budget-end"
            days={endDays}
            onDaysChange={(d) => setEndDays(d ?? BUDGET_END_DEFAULT_DAYS)}
            nowSec={nowSec}
          />
          <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            When it ends, {status.agent.name ?? 'the agent'} can no longer spend. Renewing it is a new approval on the
            agent&apos;s page.
          </p>
        </div>
      ) : null}

      {confirmFailed && (
        <WarningCallout
          // #3895: the body already says "approved"; the title says it too
          // instead of "Budget set", which is the agent page's verb.
          title="Budget approved — finishing up"
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
        <div className={`flex gap-3 ${ROW_FOOTER_OUTDENT_CLASS}`}>
          {/* The budget is signed and the agent is live. Closing is all that
              is left — to stop it, the user uses Stop budget or Remove
              agent… on its own page. Offering a cancel here would promise a reversal
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
          busyLabel={confirming ? 'Finishing…' : 'Waiting for your approval…'}
          // #3895: this screen approves; the agent page sets. Each caller
          // supplies the failure sentence its own button's verb carries.
          // The owner approves, so the sentence never makes
          // Haven the approver (copy-guidelines.md, attribution).
          failureMessage="The budget was not approved. Nothing changed — try again."
          // #3933: on a resume or a retry the agent may already hold a live
          // budget for this token, and the backend refuses a second one. Not
          // a failure, and not retryable: the control disables itself and
          // this sends the owner to the agent page, where the budget is edited.
          slotOccupiedNotice={
            <>
              {status.agent.name ?? 'This agent'} already has a live budget for{' '}
              {budget?.token_symbol ?? 'this token'}. To change it, edit that budget on{' '}
              <Link href={`/agents/${encodeURIComponent(agentId)}`} className="font-medium text-[var(--v2-brand)] hover:underline">
                the agent&rsquo;s page
              </Link>
              .
            </>
          }
          // Same footer shape as the legacy step: equal-width ghost-then-
          // primary, with the money-authority action carrying the weight.
          // Outdented to the dialog body's edges (the flow's one footer rule)
          // rather than sitting in the checklist's text column.
          actionsClassName={ROW_FOOTER_OUTDENT_CLASS}
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
                {/* #1684: "Cancel" — "Cancel setup" read ambiguously beside
                    the modal's own ✕. The primary keeps its object
                    ("Approve budget"): the one click that grants money
                    authority should name what it grants. */}
                Cancel
              </Button>
            )
          }
          readyHint={passkeyElsewhere ? <PasskeyElsewhereHint /> : undefined}
          notReadyHint={
            isWrongChain
              ? `This Haven wallet is on ${approvalChainName}. Switch networks to approve the budget.`
              : 'Connect your account owner wallet to approve the budget.'
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
              <WalletButton accountId={accountId} />
            )
          }
          onGranted={confirmWithHaven}
        />
      )}
    </>
  )
}
