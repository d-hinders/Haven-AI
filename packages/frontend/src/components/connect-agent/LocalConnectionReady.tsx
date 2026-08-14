'use client'

import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import {
  approvalBlockReason,
  type CreateSetupResponse,
} from '@/hooks/useAgentConnectionSetup'
import type { useSafeOperationGate } from '@/hooks/useSafeOperationGate'
import { describeBudgetGrant } from '@/lib/budget-period'
import WalletButton from '../WalletButton'
import { Button } from '../ui/Button'
import { AgentRulesSummary } from '../haven'
import { ConnectionVerificationFooter } from './ConnectionVerificationFooter'
import { InlineErrorNote, WarningCallout } from './SetupNotices'

/** Step 4 on the LEGACY rail: the Safe wallet-approval transaction. */
export function LocalConnectionReady({
  status,
  fallbackSetup,
  walletName,
  chainId,
  safeDetailsLoading,
  safeThreshold,
  safeOwnerCount,
  operationGate,
  publicClientReady,
  signerReady,
  approving,
  approvalError,
  onApprove,
  onCancel,
  isWrongChain,
  approvalChainName,
  onSwitchChain,
  isSwitchingChain,
}: {
  status: AgentConnectionSetupStatusResponse | null
  fallbackSetup: CreateSetupResponse
  walletName: string
  chainId: number
  safeDetailsLoading: boolean
  safeThreshold: number
  safeOwnerCount: number
  operationGate: ReturnType<typeof useSafeOperationGate>
  publicClientReady: boolean
  signerReady: boolean
  approving: boolean
  approvalError: string | null
  onApprove: () => void
  onCancel: () => void
  /** True when a wallet is connected but to the wrong chain for this approval */
  isWrongChain: boolean
  /** Human-readable name of the chain the approval requires */
  approvalChainName: string
  /** Switch the connected wallet to the approval chain */
  onSwitchChain: () => void
  /** True while a chain-switch is in flight */
  isSwitchingChain: boolean
}) {
  // The pre-approval screen is intentionally calm — single anchor surface, one
  // primary action. The runtime-restart hint used to live here as a separate
  // yellow callout; it now moves to the post-approval `active` SetupStatusState
  // where it's actually actionable. The duplicate "Local connection ready"
  // green callout collapses into a single inline check row inside the summary
  // footer below.
  const install = status?.install_status
  const budgets = status?.agent_budget ?? []
  // #1394: the same describer the approved screen uses, so the grant a user
  // reads BEFORE approving and the one they read after are worded identically.
  const displayBudgets = budgets.map((budget) => ({
    id: budget.id ?? budget.token_symbol,
    text: describeBudgetGrant(budget, chainId),
  }))
  const agentName = status?.agent.name ?? 'this agent'
  const approvalBlocked = approvalBlockReason(
    operationGate,
    safeDetailsLoading,
    status,
    publicClientReady,
    signerReady,
    isWrongChain,
    approvalChainName,
  )

  return (
    <>
      <AgentRulesSummary
        title="Approve agent rules"
        description={`You sign to give ${agentName} authority to spend within this budget. Nothing executes outside what you approve here.`}
        density="compact"
        items={[
          {
            label: 'Agent',
            value: status?.agent.name ?? 'New agent',
            helper: status?.agent.description?.trim() || undefined,
          },
          { label: 'From', value: walletName },
          {
            label: 'Budget',
            value: (
              <div className="space-y-1">
                {displayBudgets.length === 0 ? (
                  <span className="text-[var(--v2-ink-3)]">Waiting for budget</span>
                ) : (
                  displayBudgets.map((budget) => <div key={budget.id}>{budget.text}</div>)
                )}
              </div>
            ),
          },
        ]}
        footer={
          <ConnectionVerificationFooter
            delegateAddress={status?.delegate_address ?? null}
            install={install}
            safeThreshold={safeThreshold}
            safeOwnerCount={safeOwnerCount}
          />
        }
      />

      {approvalBlocked && (
        <WarningCallout title="Approval unavailable" body={approvalBlocked}>
          {operationGate.kind === 'no_signer' && isWrongChain && (
            // Wallet is connected but on the wrong chain — offer a one-click switch.
            <Button
              variant="ghost"
              size="sm"
              onClick={onSwitchChain}
              disabled={isSwitchingChain}
              className="mt-3 w-full"
            >
              {isSwitchingChain ? 'Switching network…' : `Switch to ${approvalChainName}`}
            </Button>
          )}
          {operationGate.kind === 'no_signer' && !isWrongChain && (
            // No wallet at all — show the connect button.
            <div className="mt-3">
              <WalletButton />
            </div>
          )}
        </WarningCallout>
      )}

      {approvalError && <InlineErrorNote>{approvalError}</InlineErrorNote>}

      <div className="flex gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={approving} className="flex-1">
          Cancel setup
        </Button>
        <Button
          onClick={onApprove}
          disabled={Boolean(approvalBlocked) || approving}
          className="flex-1"
        >
          {approving
            ? 'Approving...'
            : safeThreshold > 1
              ? 'Submit approval'
              : 'Approve rules'}
        </Button>
      </div>
      <span className="sr-only">{fallbackSetup.setup_id}</span>
    </>
  )
}
