'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { ConnectStepShell, type ConnectShellPhase } from './ConnectStepShell'
import { DelegationApprovalStep } from './DelegationApprovalStep'
import { LocalConnectionReady } from './LocalConnectionReady'
import { FinalizingLocalSetup, SetupDoneState, SetupStatusState, TerminalSetupState } from './SetupStates'
import { WaitingForConnector } from './WaitingForConnector'

/**
 * Step 4: everything after the setup prompt exists. Which body renders is
 * decided by the flow hook (`resolveConnectStepView`) — including the
 * #1069/#1070 rail branch between the delegation budget grant and the legacy
 * Safe wallet approval.
 */
/** #1377 C: map the resolved sub-state onto the shell's progress ticker. */
function shellPhase(kind: string | undefined): ConnectShellPhase {
  switch (kind) {
    case 'waiting_for_connector':
      return 'waiting'
    case 'finalizing_local':
    case 'delegation_approval':
    case 'legacy_approval':
    case 'approval_in_progress':
    case 'proposed':
      return 'connected'
    case 'active':
      return 'approved'
    default:
      return 'halted'
  }
}

export function ConnectStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  const { setup, setupStatus, connectView } = flow
  if (!setup) return null

  return (
    <ConnectStepShell phase={shellPhase(connectView?.kind)} stateKey={connectView?.kind ?? 'none'}>
      {connectView?.kind === 'waiting_for_connector' && (
        <WaitingForConnector
          setup={setup}
          runtime={flow.runtime}
          copied={flow.copied}
          onCopy={flow.copyText}
          manualPathRevealed={flow.manualPathRevealed}
          onManualPathRevealedChange={flow.setManualPathRevealed}
          manualFallbackConfirmed={flow.manualFallbackConfirmed}
          onManualFallbackConfirmedChange={flow.setManualFallbackConfirmed}
          manualCredential={flow.manualCredential}
          manualCredentialAcknowledged={flow.manualCredentialAcknowledged}
          manualCreating={flow.manualCreating}
          manualError={flow.manualError}
          onCreateManualCredential={flow.handleCreateManualCredential}
          onContinueAfterManualCredential={flow.handleContinueAfterManualCredential}
          loading={flow.statusLoading}
          error={flow.statusError}
          connectionStage={flow.awaitingConnectionStage}
          expiresAt={setup.expires_at}
          onCancel={flow.handleCancelSetup}
        />
      )}

      {connectView?.kind === 'finalizing_local' && (
        <FinalizingLocalSetup loading={flow.statusLoading} />
      )}

      {connectView?.kind === 'delegation_approval' && setupStatus && (
        <DelegationApprovalStep
          key={connectView.agentId}
          agentId={connectView.agentId}
          setupId={setup.setup_id}
          chainId={flow.approvalChainId}
          status={setupStatus}
          walletName={flow.approvalWalletLabel}
          onApproved={flow.handleDelegationApproved}
          onCancel={flow.handleCancelSetup}
          onClose={flow.handleClose}
          isWrongChain={flow.isWrongChain}
          approvalChainName={flow.approvalChainName}
          onSwitchChain={flow.switchToApprovalChain}
          isSwitchingChain={flow.isSwitchingChain}
        />
      )}

      {connectView?.kind === 'legacy_approval' && (
        <LocalConnectionReady
          status={setupStatus}
          fallbackSetup={setup}
          walletName={flow.approvalWalletLabel}
          chainId={flow.approvalChainId}
          safeDetailsLoading={flow.safeDetailsLoading}
          safeThreshold={flow.safeThreshold}
          safeOwnerCount={flow.safeOwnerCount}
          operationGate={flow.operationGate}
          publicClientReady={flow.publicClientReady}
          signerReady={flow.signerReady}
          approving={flow.approving}
          approvalError={flow.approvalError}
          onApprove={flow.handleApproveAgentRules}
          onCancel={flow.handleCancelSetup}
          isWrongChain={flow.isWrongChain}
          approvalChainName={flow.approvalChainName}
          onSwitchChain={flow.switchToApprovalChain}
          isSwitchingChain={flow.isSwitchingChain}
        />
      )}

      {connectView?.kind === 'approval_in_progress' && (
        <SetupStatusState
          title="Approval in progress"
          body="Haven is waiting for wallet approval. The agent cannot spend from the Haven wallet until approval is complete."
          tone="warning"
          primaryLabel="Done"
          onPrimary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'proposed' && (
        <SetupStatusState
          title="Waiting for more approvals"
          body="The agent rules were proposed for wallet approval. Spending is not active until the remaining approvals are complete."
          tone="warning"
          primaryLabel="Done"
          onPrimary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'active' && (
        <SetupDoneState
          runtime={flow.runtime}
          skillInstalled={Boolean(setupStatus?.install_status?.skill_installed)}
          agentName={setupStatus?.agent.name}
          budgets={setupStatus?.agent_budget}
          walletName={setupStatus?.haven_wallet.name ?? flow.approvalWalletLabel}
          chainId={setupStatus?.haven_wallet.chain_id ?? flow.approvalChainId}
          onClose={flow.handleClose}
        />
      )}

      {connectView?.kind === 'expired' && (
        <TerminalSetupState
          title="Setup prompt expired"
          badgeLabel="Expired"
          body="Create a new setup prompt, then paste the fresh prompt into your agent environment."
          tone="warning"
          primaryLabel="Create a new setup"
          onPrimary={() => flow.restartFromReview()}
          secondaryLabel="Close"
          onSecondary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'cancelled' && (
        <TerminalSetupState
          title="Setup cancelled"
          badgeLabel="Cancelled"
          body="This setup can no longer connect an agent. Create a new setup prompt when you are ready."
          tone="neutral"
          primaryLabel="Create a new setup"
          onPrimary={() => flow.restartFromReview({ clearCancelled: true })}
          secondaryLabel="Close"
          onSecondary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'failed' && (
        <TerminalSetupState
          title="Setup failed"
          badgeLabel="Failed"
          body={setupStatus?.failure_reason ?? 'Create a new setup prompt and try again.'}
          tone="danger"
          primaryLabel="Create a new setup"
          onPrimary={() => flow.restartFromReview()}
          secondaryLabel="Close"
          onSecondary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'unknown_status' && (
        <SetupStatusState
          title="Setup status updated"
          body="Haven received a setup status this preview does not recognize yet. Refresh the page or create a new setup if this does not resolve."
          tone="neutral"
          primaryLabel="Done"
          onPrimary={flow.handleClose}
        />
      )}
    </ConnectStepShell>
  )
}
