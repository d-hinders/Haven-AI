'use client'

import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { ConnectStepShell, type ConnectShellPhase } from './ConnectStepShell'
import { DelegationApprovalStep } from './DelegationApprovalStep'
import { FinalizingLocalSetup, SetupDoneState, SetupStatusState, TerminalSetupState } from './SetupStates'
import { SupersededAgentsCard } from './SupersededAgentsCard'
import { WaitingForConnector } from './WaitingForConnector'

/**
 * Step 4: everything after the setup prompt exists. Which body renders is
 * decided by the flow hook (`resolveConnectStepView`) — including the
 * #1069/#1070 rail branch between the delegation budget grant and the retired
 * Safe rail refusal.
 */
/** #1377 C: map the resolved sub-state onto the shell's progress ticker. */
function shellPhase(kind: string | undefined): ConnectShellPhase {
  switch (kind) {
    case 'waiting_for_connector':
      return 'waiting'
    case 'finalizing_local':
    case 'delegation_approval':
      return 'connected'
    case 'active':
      return 'approved'
    default:
      return 'halted'
  }
}

export function ConnectStep({ flow }: { flow: AgentConnectionSetupFlow }) {
  const { setup, setupStatus, connectView, resumed } = flow
  // #2522: `setup` is the CREATE response, and a session resumed from a
  // hand-off link (`/agents?setup=<id>`) never has one — it renders from the
  // polled status instead. Guarding on `setup` alone returned null for every
  // status on that path, so the modal opened with chrome and a blank body.
  if (!setup && !resumed) return null

  // #2522, second review round: a resumed session whose status never loads.
  // `resolveConnectStepView` returns null when there is no status, so without
  // this the modal renders chrome over an empty body — the same failure the
  // first round found, reached by a different route, and by the likeliest
  // route in practice: a stale or mistyped hand-off link.
  //
  // The poll behind this retries forever by design (#1404, so a live connect
  // survives a dropped request); that decision is not disturbed here. What
  // changes is that the surface stops staying silent about it.
  //
  // DEVIATION from the issue's wording, recorded rather than glossed: the
  // acceptance criterion says a foreign or unknown id shows not-found "and no
  // modal". Not-found INSIDE the modal is what ships, because the alternative
  // leaves someone who followed a link looking at an unchanged agents page
  // with no account of what happened.
  if (resumed && flow.statusError && !setupStatus) {
    return (
      <ConnectStepShell phase="halted" stateKey="resume_not_found">
        <SetupStatusState
          title="We could not open this setup"
          body="The link may be out of date, or this setup may belong to a different Haven account. Ask the agent for a fresh link."
          tone="warning"
          primaryLabel="Close"
          onPrimary={flow.handleClose}
        />
      </ConnectStepShell>
    )
  }

  /**
   * Terminal states offer "Create a new setup", which drops the user on the
   * REVIEW step — and a resumed session never filled in the details or policy
   * steps, so name and budget are empty there and the submit button does not
   * gate on either. It would post an unnamed, budget-less setup against
   * whichever wallet the viewer happens to default to, not the one this setup
   * was for. Second review round; on this path the only honest action is to
   * close and go back to the agent that sent the link.
   */
  const terminalPrimary = resumed
    ? { label: 'Close', onPress: flow.handleClose }
    : null

  // #1672: once the connector has run, the setup status carries the runtime it
  // DETECTED in the executing environment. Runtime-specific copy (restart
  // guidance, the Codex Desktop note) keys off this.
  //
  // #1720 removed the picker, so there is no longer a pre-run value to fall
  // back to — before the connector reports, the runtime is genuinely unknown
  // and the empty string says so. Every consumer already had to handle "the
  // connector has not reported yet"; that state is now simply reached by
  // everyone rather than by the command path alone.
  const effectiveRuntime = setupStatus?.runtime ?? ''

  return (
    <ConnectStepShell phase={shellPhase(connectView?.kind)} stateKey={connectView?.kind ?? 'none'}>
      {/*
        The waiting screen is the "paste this into your agent" screen, so it
        needs the create response's token and command. A resumed session has
        neither, by design — the person following the link is here to approve a
        budget, and handing them a connector command would be handing them
        somebody else's terminal step. They get an honest state instead.
      */}
      {connectView?.kind === 'waiting_for_connector' && !setup && (
        <SetupStatusState
          title="Not connected yet"
          body="Nothing to approve until the agent runs its connector command. That command is in the session where this setup was created, and you do not need it here."
          tone="neutral"
          primaryLabel="Close"
          onPrimary={flow.handleClose}
        />
      )}

      {connectView?.kind === 'waiting_for_connector' && setup && (
        <WaitingForConnector
          setup={setup}
          runtime={effectiveRuntime}
          copied={flow.copied}
          onCopy={flow.copyText}
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
          setupId={setup?.setup_id ?? setupStatus.setup_id}
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


      {connectView?.kind === 'active' && (
        <SetupDoneState
          runtime={effectiveRuntime}
          skillInstalled={Boolean(setupStatus?.install_status?.skill_installed)}
          agentName={setupStatus?.agent.name}
          budgets={setupStatus?.agent_budget}
          walletName={setupStatus?.haven_wallet.name ?? flow.approvalWalletLabel}
          chainId={setupStatus?.haven_wallet.chain_id ?? flow.approvalChainId}
          onClose={flow.handleClose}
          // Inside the done state, above its Done button — two rendered
          // captures to get here (#2561). Placing the offer FIRST made a
          // "replaced / revoke" decision the first thing a reader met, ahead
          // of the grant line that screen exists to state. Placing it after
          // the whole component put it below `Done`, where the one action a
          // finished screen invites closes the modal past it. Above the
          // button is the only spot that is both: the success stays the
          // heading, and the follow-up is still read. It renders nothing
          // unless the connector reported agents this owner actually has.
          beforeDone={
            <SupersededAgentsCard
              supersededAgentIds={setupStatus?.install_status?.superseded_agent_ids}
            />
          }
        />
      )}

      {connectView?.kind === 'expired' && (
        <TerminalSetupState
          title="Setup prompt expired"
          badgeLabel="Expired"
          body="Create a new setup prompt, then paste the fresh prompt into your agent environment."
          tone="warning"
          primaryLabel={terminalPrimary?.label ?? 'Create a new setup'}
          onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromReview())}
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
          primaryLabel={terminalPrimary?.label ?? 'Create a new setup'}
          onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromReview({ clearCancelled: true }))}
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
          primaryLabel={terminalPrimary?.label ?? 'Create a new setup'}
          onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromReview())}
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
