'use client'

import { useEffect, useRef, useState } from 'react'
import type { AgentConnectionSetupFlow } from '@/hooks/useAgentConnectionSetup'
import { ConnectAgentRow } from './ConnectAgentRow'
import { ConnectStepShell } from './ConnectStepShell'
import { ConnectSteps, type ConnectStepRow } from './ConnectSteps'
import { DelegationApprovalStep } from './DelegationApprovalStep'
import { SetupDoneState, SetupStatusState, TerminalSetupState } from './SetupStates'
import { SupersededAgentsCard } from './SupersededAgentsCard'
import { WaitingForConnector } from './WaitingForConnector'

/**
 * #4706: how long a row's Step stays flagged after it goes done. The
 * `check-pop` animation is 320ms; the flag is cleared a beat later so the
 * class is gone before the next sub-state remount could replay it.
 */
const PLAY_MS = 400

/** Connect-step views where the agent row says "Connected just now". */
const CONNECTED_VIEWS = new Set(['finalizing_local', 'delegation_approval', 'active'])

/**
 * #4706: which checklist rows are done in a given connect view. The waiting
 * screen's own rows are not tracked — its row 1 ticks on a copy and its row 2
 * on the manual path, and neither plays.
 */
function doneRowIds(kind: string | null): Set<string> {
  switch (kind) {
    case 'finalizing_local':
    case 'delegation_approval':
      return new Set(['copy', 'paste'])
    case 'active':
      return new Set(['copy', 'paste', 'approve'])
    default:
      return new Set()
  }
}

/**
 * Step 3: everything after the setup prompt exists. Which body renders is
 * decided by the flow hook (`resolveConnectStepView`) — including the
 * #1069/#1070 rail branch between the delegation budget grant and the retired
 * Safe rail refusal.
 */
/**
 * #3832: rows 1-2 once the agent has connected. Any status past
 * `waiting_for_connector` means both are behind the user, so both render
 * done — including on a session resumed from a hand-off link (#2522).
 *
 * The done titles say what is TRUE on each path, not what this browser did:
 * - connector path: the agent received the prompt and its connector ran —
 *   true whether or not this browser was the one that copied it. Row 2 names
 *   the agent (#4706: "{name} connected"), falling back to "Agent connected"
 *   when no name is known — never an empty name;
 * - manual-credential path (#2482): no prompt was pasted and no connector
 *   ran; the credentials were made in the browser and saved by the user.
 */
function connectedRows({
  approve,
  manual,
  agentName,
  play,
}: {
  approve: ConnectStepRow
  manual: boolean
  agentName: string | null
  play: { paste: boolean; approve: boolean }
}): ConnectStepRow[] {
  return [
    { id: 'copy', state: 'done', title: manual ? 'Credentials created' : 'Prompt received by your agent' },
    {
      id: 'paste',
      state: 'done',
      title: manual ? 'Credentials saved' : agentName ? `${agentName} connected` : 'Agent connected',
      play: play.paste,
    },
    { ...approve, play: approve.state === 'done' ? play.approve : false },
  ]
}

export function ConnectStep({
  flow,
  nestedCopyBlocks = false,
  halo = false,
}: {
  flow: AgentConnectionSetupFlow
  /** See WaitingForConnector's prop of the same name (#4065). */
  nestedCopyBlocks?: boolean
  /** Dialog-only attention cue; the inline /agents flow stays still. */
  halo?: boolean
}) {
  const { setup, setupStatus, connectView, resumed } = flow
  // #4706: the name the row and row 2 use. The server's name wins once the
  // status has it; while waiting it comes from the flow's own state (the name
  // typed on step 1). `null` when neither is known — the row is left out and
  // row 2 falls back to "Agent connected", never an empty name.
  const agentName = setupStatus?.agent.name?.trim() || flow.name?.trim() || null
  const manualPath = Boolean(setupStatus?.install_status?.manual_credential_fallback)
  const viewKind = connectView?.kind ?? null

  // #4706: which rows have played their Step, tracked ABOVE ConnectStepShell's
  // key. The shell remounts its body on every sub-state change, so a mount
  // cannot mean "just happened" — the live path is itself a remount. Seeded
  // from the first status seen, so a session resumed from a hand-off link
  // (#2522) or an already-connected first status shows the static check.
  const seenDoneRef = useRef<Set<string> | null>(null)
  const playTimerRef = useRef<number | null>(null)
  const [playingRows, setPlayingRows] = useState<ReadonlySet<string>>(new Set())
  // ONE live region for the whole step: the agent row and the checklist row
  // both change when the agent connects, and § ConnectSteps asks for one
  // announcement per change, not two.
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    // Seed from the first STATUS seen, not the first render: a resumed session
    // mounts with no status at all, and its first status is already past
    // waiting — that must seed, not play.
    if (viewKind === null) return
    const doneNow = doneRowIds(viewKind)
    const previous = seenDoneRef.current
    seenDoneRef.current = doneNow
    // First status seen: seed only. A row already done then never plays.
    if (previous === null) return
    if (viewKind === 'waiting_for_connector') setAnnouncement('')
    const justDone = [...doneNow].filter((id) => !previous.has(id))
    // Row 2 plays only on the connector path: on the manual path it was
    // already done in the waiting screen ("Credentials created"), and the
    // user's own "Continue" is the change, not the agent reaching Haven.
    const playable = justDone.filter((id) => id === 'approve' || (id === 'paste' && !manualPath))
    // A sub-state change remounts the body, so a flag left over from the
    // previous sub-state would replay on the remount. Clear first.
    setPlayingRows((prev) => (prev.size === 0 && playable.length === 0 ? prev : new Set(playable)))
    if (playTimerRef.current !== null) window.clearTimeout(playTimerRef.current)
    // The announcement is the change, not the play: the manual path's row 2
    // still goes done ("Credentials saved") and is announced once, even though
    // its check does not pop.
    if (justDone.includes('paste')) {
      setAnnouncement(
        manualPath ? 'Credentials saved' : agentName ? `${agentName} connected` : 'Agent connected',
      )
    } else if (justDone.includes('approve')) {
      setAnnouncement('Budget approved')
    }
    if (playable.length === 0) return
    playTimerRef.current = window.setTimeout(() => {
      setPlayingRows(new Set())
      playTimerRef.current = null
    }, PLAY_MS)
  }, [viewKind, manualPath, agentName])

  useEffect(
    () => () => {
      if (playTimerRef.current !== null) window.clearTimeout(playTimerRef.current)
    },
    [],
  )

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
      <ConnectStepShell stateKey="resume_not_found">
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
    <>
      {/* #4706: ONE live region for the step. The agent row and the checklist
          row both change when the agent connects; § ConnectSteps asks for one
          announcement per change, not two. It sits OUTSIDE the shell's keyed
          body so a sub-state change does not remount it (a fresh live region
          announces nothing). */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <ConnectStepShell stateKey={connectView?.kind ?? 'none'}>
        {/* #4706: who you are waiting for, once it has connected. The waiting
            screen renders the same row itself (it owns "Listening for it…");
            this one carries "Connected just now" above the checklist. */}
        {agentName && viewKind && CONNECTED_VIEWS.has(viewKind) && (
          <ConnectAgentRow name={agentName} state="connected" />
        )}
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
            body="If you already pasted the setup prompt into your agent, this screen moves on to budget approval as soon as it connects. If you no longer have the prompt, close this and choose Start again on the dashboard."
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
            promptCopied={flow.promptCopied}
            keyMadeInBrowser={Boolean(flow.manualCredential || manualPath)}
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
            nestedCopyBlocks={nestedCopyBlocks}
            halo={halo}
            agentName={agentName ?? ''}
          />
        )}

        {connectView?.kind === 'finalizing_local' && (
          <ConnectSteps
            halo={halo}
            rows={connectedRows({
              approve: {
                id: 'approve',
                state: 'working',
                // `connected_local` before the install is approval-ready: the
                // agent IS connected (row 2 is honestly done) and the approval is
                // not open yet, so the in-flight row says what it is doing — the
                // approval being prepared — not the gate it leads to. "Approve
                // the budget" over "the connector is finishing local setup" named
                // one thing and described another. The row stays row 3 and stays
                // working, so the list never steps backwards on its way to
                // "Review and approve".
                title: 'Preparing the approval',
                children: (
                  // #1377 C: static text — polling must never swap it. The modal
                  // subtitle already says "Finishing local setup"; this line only
                  // sets the wait, so the work is named once per viewport.
                  <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                    This usually takes a few seconds.
                  </p>
                ),
              },
              manual: manualPath,
              agentName,
              play: { paste: playingRows.has('paste'), approve: false },
            })}
          />
        )}

        {connectView?.kind === 'delegation_approval' && setupStatus && (
          <ConnectSteps
            halo={halo}
            rows={connectedRows({
              approve: {
                id: 'approve',
                state: 'active',
                // The modal subtitle names the gate ("Approve the agent budget",
                // pinned by e2e/connect-agent.spec.ts). The heading shares its
                // verb on purpose: owner decision 2026-10-16 that this step says
                // "approve", not "sign" (copy-guidelines.md prefers "approve
                // actions"), which outranks #1684's "say it in other words" here.
                title: 'Review and approve',
                wideBodyOnMobile: true,
                children: (
                  <DelegationApprovalStep
                    key={connectView.agentId}
                    agentId={connectView.agentId}
                    setupId={setup?.setup_id ?? setupStatus.setup_id}
                    chainId={flow.approvalChainId}
                    accountId={flow.approvalAccountId}
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
                ),
              },
              manual: manualPath,
              agentName,
              play: { paste: playingRows.has('paste'), approve: false },
            })}
          />
        )}


        {connectView?.kind === 'active' && (
          // #3832: all three rows done, with the status word the old ticker's
          // "Approved" used to carry. The grant line below stays the heading of
          // what the user just did (#1394).
          <ConnectSteps
            halo={halo}
            rows={connectedRows({
              approve: { id: 'approve', state: 'done', title: 'Budget approved' },
              manual: manualPath,
              agentName,
              play: { paste: playingRows.has('paste'), approve: playingRows.has('approve') },
            })}
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
            // #4706: the read-only "Say hello" check is for the connector path
            // only; the manual-credential path hands out env lines.
            connectorPath={!manualPath}
            nestedCopyBlocks={nestedCopyBlocks}
            // Inside the done state, above its Done button — two rendered
            // captures to get here (#2561). Placing the list FIRST made the
            // other agents on this machine the first thing a reader met, ahead
            // of the grant line that screen exists to state. Placing it after
            // the whole component put it below `Done`, where the one action a
            // finished screen invites closes the modal past it. Above the
            // button is the only spot that is both: the success stays the
            // heading, and the note is still read. It lists, and offers no
            // action on, the other agents the connector found (#3830), and
            // renders nothing unless those are not-revoked agents this owner has.
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
            onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromPolicy())}
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
            onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromPolicy({ clearCancelled: true }))}
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
            onPrimary={terminalPrimary?.onPress ?? (() => flow.restartFromPolicy())}
            secondaryLabel="Close"
            onSecondary={flow.handleClose}
          />
        )}

        {connectView?.kind === 'unknown_status' && (
          <SetupStatusState
            title="Setup status updated"
            body="Haven received a setup status this preview does not recognise yet. Refresh the page or create a new setup if this does not resolve."
            tone="neutral"
            primaryLabel="Done"
            onPrimary={flow.handleClose}
          />
        )}
      </ConnectStepShell>
    </>
  )
}
