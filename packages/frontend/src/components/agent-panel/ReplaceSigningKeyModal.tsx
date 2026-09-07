'use client'

/**
 * Replace an agent's signing key (#1701, epic #1694).
 *
 * The owner-facing half of the re-key flow. An agent can never re-key itself
 * — that would be an agent editing its own authority — so this is authorised
 * by the account owner here, with the owner's own signature.
 *
 * ## The shape of the flow, and why it is not a wizard
 *
 * Four of these steps are ordinary and reversible. ONE is not. Once the
 * revoke lands on-chain the agent's authority is gone, abandoning cannot give
 * it back, and the abandoned re-key holds the agent's one in-flight slot
 * forever (#1868) — recovery is a manual re-grant by the owner. So the revoke
 * is presented as a GATE with its own acknowledgement, not as step 3 of 5,
 * and no copy anywhere in this file tells the user they can stop safely once
 * they are past it. Before it, cancelling really is free, and the copy says
 * that too.
 *
 * ## Where the destructive button renders, and why it is not the footer
 *
 * A gate only gates what is behind it. `ui/Modal` puts its footer OUTSIDE the
 * scrolling body, so a footer button is on screen from the first paint no
 * matter how long the body is — and this body is ~2.7 screen-heights at 390px.
 * The gate was therefore intact on desktop and defeated on a phone: the
 * irreversible control sat about three screens above the banner explaining it
 * and the checkbox enabling it, in the easiest place on a phone to mis-tap
 * (#1887).
 *
 * The fix is positional and one-directional: the BUTTON moved down, into the
 * red banner as its last child. The warning did not move up and was not
 * shortened — the banner and the acknowledgement ARE the gate, so buying
 * vertical space out of them would spend the thing being protected. It applies
 * only where a gate exists: a resumed re-key is past the revoke and renders no
 * banner, so its forward action stays in the footer rather than being buried
 * for the sake of symmetry.
 *
 * ## Later siblings this flow must describe accurately
 *
 * Two fixes landed after the first version of this modal, and both change what
 * an owner should expect after the revoke:
 *
 * - **#1699** re-anchors an anchored Agent Passport asynchronously. Standing
 *   remains unchanged while the public on-chain record briefly catches up.
 * - **#1849** plans the replacement on the metering clock. If a budget period
 *   ends before issue, the expired carry is dropped and, while the original
 *   recurring grant remains active, the full budget for the current period is
 *   issued instead of silently carrying zero.
 *
 * A third used to sit here and no longer does. #1870/#1890 closed: the backend
 * takes a `signature_scheme` (PR #1891) and this flow now sends one, so a
 * passkey-signing owner completes the whole re-key. The only refusal left is
 * `no_signer` — no signer of any kind reachable on this device — and that one
 * is real.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StepProgress } from '@/components/ui/StepProgress'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Checkbox } from '@/components/ui/Checkbox'
import { ApprovalRequiredBanner, Address } from '@/components/haven'
import { formatAllowanceAmount } from '@/lib/allowance-format'
import { timeAgo } from '@/lib/format'
import {
  useAgentRekey,
  type IssuedDelegation,
  type RekeyFailure,
  type CompleteResult,
} from '@/hooks/useAgentRekey'
import type { PaymentActivityItem } from '@/hooks/useAgentActivity'

/** Why the owner is replacing the key. Same mechanics, different urgency. */
type Reason = 'lost' | 'compromised'

type Step = 'reason' | 'address' | 'consequences' | 'signing' | 'stalled' | 'done'

const STEP_ORDER: Step[] = ['reason', 'address', 'consequences', 'signing']

/** USDC everywhere the sweep helper is concerned; see `sweepUsdcAddress`. */
const RESIDUAL_DECIMALS = 6

function formatUsdc(atomic: string): string {
  return formatAllowanceAmount(atomic, RESIDUAL_DECIMALS, { symbol: 'USDC' })
}

/**
 * Our own prose for a refusal. The server's `message` is used only for the
 * genuinely-unexpected case — everything a user can act on gets a sentence
 * that names the action.
 */
function failureCopy(failure: RekeyFailure): string {
  switch (failure.kind) {
    case 'cancelled':
      return 'Signing was cancelled. Nothing changed.'
    case 'delegate_in_use':
      return 'Another one of your agents is already using that signing address. Generate a fresh key on the agent’s machine and paste the new address.'
    case 'residual_read_failed':
      return 'Haven could not check the balance on the current signing address, and replacing the key retires the only key that could move it. Try again in a moment.'
    case 'carry_refused':
      return 'The replacement budget could not be worked out from the old one, so nothing was issued. The agent has no budget until you set one. Contact support before retrying.'
    case 'legacy_rail':
      return failure.message
    case 'residual':
      return `The current signing address still holds ${formatUsdc(failure.atomic)} USDC.`
    case 'in_flight':
      return 'This agent already has a key replacement in progress.'
    case 'out_of_order':
      return 'This key replacement has already moved past that step. Reopen it to see where it stands.'
    case 'missing_signature':
      return 'One of the replacement budget rules was not signed, so nothing was changed. Try again and approve every prompt.'
    case 'completion_failed':
      return 'The replacement could not be finished, and nothing was changed by this attempt. You can try again.'
    default:
      return failure.message
  }
}

export function ReplaceSigningKeyModal({
  open,
  onClose,
  agentId,
  agentName,
  chainId,
  currentDelegateAddress,
  recentPayments,
  hasAnchoredPassport,
  onCompleted,
}: {
  open: boolean
  onClose: () => void
  agentId: string
  agentName: string
  chainId: number
  /**
   * Re-key is delegation-rail only (#1694 owner decision). An older account's
   * authority is a set of per-token allowances rather than a signed
   * delegation, so there is no key to replace and re-onboarding is the path.
   */
  currentDelegateAddress: string | null
  /** Feeds the compromised path's damage assessment. */
  recentPayments: PaymentActivityItem[]
  /** Shows the #1699 disclosure only when there is an anchored record to replace. */
  hasAnchoredPassport: boolean
  onCompleted: () => void
}) {
  const rekey = useAgentRekey(agentId, chainId)
  const [step, setStep] = useState<Step>('reason')
  const [reason, setReason] = useState<Reason | null>(null)
  const [newAddress, setNewAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [residual, setResidual] = useState<{ atomic: string } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [signingLabel, setSigningLabel] = useState<string | null>(null)
  const [result, setResult] = useState<CompleteResult | null>(null)
  const [issuedDelegations, setIssuedDelegations] = useState<IssuedDelegation[]>([])
  const [skippedCount, setSkippedCount] = useState(0)
  const [keyCopied, setKeyCopied] = useState(false)

  const copyKey = useCallback(async (key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      setKeyCopied(true)
    } catch {
      // The key is on screen and selectable; a failed clipboard write is not
      // worth an error banner over the one screen that shows it once.
    }
  }, [])

  useEffect(() => {
    if (open) void rekey.loadSigners()
  }, [open, rekey.loadSigners])

  const reset = useCallback(() => {
    setStep('reason')
    setReason(null)
    setNewAddress('')
    setError(null)
    setResidual(null)
    setAcknowledged(false)
    setResumed(false)
    setSigningLabel(null)
    setResult(null)
    setIssuedDelegations([])
    setSkippedCount(0)
    setKeyCopied(false)
  }, [])

  /**
   * Closing is free before the revoke and destructive after it. The modal
   * refuses to be dismissed by backdrop or Escape once past that line, so a
   * stray click cannot strand the agent — the only way out is the button that
   * says what it costs.
   */
  const past = rekey.pointOfNoReturnCrossed
  // Past the revoke the dialog refuses backdrop/Escape dismissal so a stray
  // click cannot strand the agent — but `stalled` and `done` are terminal
  // screens the owner must be able to leave. Being unable to close was itself
  // a defect: a declined signature prompt left the modal with no exit at all.
  const closeIsSafe = !past || step === 'done' || step === 'stalled'

  const handleClose = useCallback(() => {
    if (step === 'done') {
      onCompleted()
    }
    // Release the agent's ONE in-flight slot on the way out (code review on
    // #1701). Preflight opens a real `agent_rekeys` row, and
    // `idx_agent_rekeys_one_in_flight` permits exactly one — so a Cancel that
    // only closed the dialog left the row occupying that slot with nothing to
    // expire it, and the owner's NEXT attempt would 409 into the resume path
    // over a re-key they had already walked away from. That made "closing this
    // is free" false in effect, which is the one promise this screen cannot
    // afford to break. Only ever before the revoke: past it, abandoning
    // records the stop but cannot undo the on-chain revocation (#1868), so the
    // stalled screen owns that decision instead.
    if (!rekey.pointOfNoReturnCrossed) {
      void rekey.abandon()
    }
    reset()
    onClose()
  }, [step, onCompleted, onClose, reset, rekey])

  const addressValid = useMemo(
    () =>
      isAddress(newAddress.trim()) &&
      newAddress.trim().toLowerCase() !== (currentDelegateAddress ?? '').toLowerCase(),
    [newAddress, currentDelegateAddress],
  )

  const runPreflight = useCallback(
    async (disposition?: 'swept' | 'acknowledged_unrecoverable') => {
      setError(null)
      const res = await rekey.preflight(newAddress.trim(), disposition)
      if (res.ok) {
        setResidual(null)
        setStep('consequences')
        return
      }
      if (res.failure.kind === 'residual') {
        setResidual({ atomic: res.failure.atomic })
        setStep('consequences')
        return
      }
      if (res.failure.kind === 'in_flight') {
        // Resume rather than restart. The in-flight row is bound to the
        // signing address given when it was STARTED, which the 409 does not
        // report — so the flow says so instead of implying the address above
        // is the one that will be wired.
        setResumed(true)
        setStep('consequences')
        return
      }
      setError(failureCopy(res.failure))
    },
    [rekey, newAddress],
  )

  /**
   * The owner-signed sequence, ENTERED AT THE RIGHT STAGE.
   *
   * This used to always begin with `revoke()`, which meant a resumed re-key —
   * the exact #1868 population the flow is built around — hit the backend's
   * `submitRevoke requires stage 'preflight'` guard and died on a 409 it could
   * never get past. The resume banner promised something the code could not
   * do (code review on #1701).
   *
   * `resumeMode` decides, and it is derived from what the stage machine
   * actually permits rather than from what would be convenient. `stranded`
   * never reaches here — the footer offers no action for it.
   */
  const runRekey = useCallback(async () => {
    setError(null)
    setStep('signing')

    if (rekey.resumeMode === 'full') {
      setSigningLabel('Waiting for your signature to switch off the old key…')
      const revoked = await rekey.revoke()
      if (!revoked.ok) {
        // Nothing landed: the re-key is still at `preflight` and the old key
        // still works, so this is safely retryable from the gate.
        setSigningLabel(null)
        setError(failureCopy(revoked.failure))
        setStep('consequences')
        return
      }
    }

    setSigningLabel('Working out the replacement budget…')
    const issued = await rekey.issue()
    if (!issued.ok) {
      setSigningLabel(null)
      setError(failureCopy(issued.failure))
      setStep('stalled')
      return
    }
    setIssuedDelegations(issued.value.delegations)
    setSkippedCount(issued.value.skipped?.length ?? 0)

    const n = issued.value.delegations.length
    setSigningLabel(
      n === 0
        ? 'Finishing…'
        : `Waiting for your approval of the replacement budget (${n} to approve)…`,
    )
    const done = await rekey.complete(issued.value.delegations)
    setSigningLabel(null)
    if (!done.ok) {
      setError(failureCopy(done.failure))
      setStep('stalled')
      return
    }
    setResult(done.value)
    setStep('done')
  }, [rekey])

  /**
   * Whether THIS SESSION can still carry the re-key forward.
   *
   * Deliberately not `resumeMode`, and the distinction cost a test to find.
   * `resumeMode` answers "could a client that just discovered this re-key
   * finish it?" — and at stage `issued` the answer is no, because the signing
   * payloads only ever existed in the `/issue` response and no route serves
   * them again. But a session that is still holding that response has exactly
   * what it needs. Collapsing the two made a failed `complete()` — a declined
   * wallet prompt, the single most likely failure in the whole flow — render
   * as permanently stuck while the retry was sitting in a state variable.
   */
  const canRetry =
    rekey.resumeMode === 'resume' ||
    (rekey.stage === 'issued' && issuedDelegations.length > 0)

  /**
   * Retry from wherever the re-key actually is. The common case is mundane:
   * `complete()` asks for one signature per replacement rule, so declining the
   * second of three prompts lands here with nothing submitted — and before
   * this existed the modal had no button left to press.
   */
  const retry = useCallback(async () => {
    setError(null)
    // Already-built delegations must not be rebuilt: `/issue` refuses at any
    // stage but `metered`, so re-running it would 409 over work already done.
    if (rekey.stage === 'issued' && issuedDelegations.length > 0) {
      setStep('signing')
      setSigningLabel(
        `Waiting for your approval of the replacement budget (${issuedDelegations.length} to approve)…`,
      )
      const done = await rekey.complete(issuedDelegations)
      setSigningLabel(null)
      if (!done.ok) {
        setError(failureCopy(done.failure))
        setStep('stalled')
        return
      }
      setResult(done.value)
      setStep('done')
      return
    }
    await runRekey()
  }, [rekey, issuedDelegations, runRekey])

  const blocked = rekey.signingBlockedReason
  const stepIndex = step === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step)

  /**
   * Whether the irreversibility gate is on screen — the red banner and the
   * acknowledgement checkbox bound to it.
   *
   * Exactly the condition the banner already rendered under; naming it lets
   * the footer ask the same question. It is false for a RESUMED re-key (the
   * revoke already landed, so there is no gate left to pass) and false while a
   * residual is unresolved (that banner owns the screen and offers its own two
   * dispositions).
   */
  const gateOnScreen = !residual && rekey.resumeMode === 'full'


  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={step === 'done' ? 'Signing key replaced' : 'Replace signing key'}
      subtitle={step === 'done' ? undefined : agentName}
      width="lg"
      closeOnBackdrop={closeIsSafe}
      closeOnEscape={closeIsSafe}
      showCloseButton={closeIsSafe}
      headerAccessory={
        step === 'done' ? null : <StepProgress totalSteps={STEP_ORDER.length} currentStep={stepIndex} />
      }
      footer={renderFooter()}
    >
      {error ? (
        <ApprovalRequiredBanner title="That did not go through" tone="danger" density="compact">
          <p className="text-sm leading-relaxed">{error}</p>
        </ApprovalRequiredBanner>
      ) : null}

      {/* The refusal gates the IRREVERSIBLE action, not the reading of it.
          An owner who cannot sign here still needs to learn what replacing a
          key costs and what they must go and fetch — disabling the flow at
          step one tells them only that something is wrong. Everything up to
          the revoke is reversible (a re-key at `preflight` abandons cleanly),
          so the banner rides along and only the last button is dead. */}
      {blocked && step !== 'done' ? (
        <ApprovalRequiredBanner title="You cannot replace this key from this device" tone="warning">
          <p className="text-sm leading-relaxed">
            Connect the wallet that owns this Haven account, or use a device with one of its
            passkeys. Replacing a signing key needs the account owner’s signature, and Haven never
            signs on your behalf.
          </p>
        </ApprovalRequiredBanner>
      ) : null}

      {step === 'reason' ? renderReason() : null}
      {step === 'address' ? renderAddress() : null}
      {step === 'consequences' ? renderConsequences() : null}
      {step === 'signing' ? renderSigning() : null}
      {step === 'stalled' ? renderStalled() : null}
      {step === 'done' ? renderDone() : null}
    </Modal>
  )

  function renderReason() {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          This gives {agentName} a new signing key and a new API key, and switches off the old
          ones. The agent keeps its name, its history and its budget.
        </p>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-[var(--v2-ink)]">
            What happened to the old key?
          </legend>
          <ReasonOption
            value="lost"
            selected={reason === 'lost'}
            onSelect={setReason}
            title="It is lost"
            body="The key is gone — a wiped machine, a deleted folder. The old authority is switched off as part of this."
          />
          <ReasonOption
            value="compromised"
            selected={reason === 'compromised'}
            onSelect={setReason}
            title="It may be in someone else’s hands"
            body="Same steps, but check what the agent has spent recently before you continue."
          />
        </fieldset>

        {reason === 'compromised' ? (
          <div className="rounded-lg border border-[var(--v2-border)] p-4">
            <h4 className="text-sm font-medium text-[var(--v2-ink)]">Recent spending to review</h4>
            <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Anything here that you did not authorise was paid with the key you are replacing.
              Replacing it stops further spending; it does not reverse a payment that already
              settled.
            </p>
            {recentPayments.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--v2-ink-3)]">
                No payments recorded for this agent.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {recentPayments.slice(0, 5).map((p) => (
                  <li
                    key={p.id}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-[var(--v2-ink-2)]">{timeAgo(p.created_at)}</span>
                    <span className="v2-tabular font-medium text-[var(--v2-ink)]">
                      {p.amount} {p.token}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    )
  }

  function renderAddress() {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          On the machine that runs {agentName}, generate a new key. Paste the{' '}
          <strong className="font-medium text-[var(--v2-ink)]">public address</strong> it prints
          below.
        </p>
        <ApprovalRequiredBanner title="Haven never receives the private key" tone="neutral" density="compact">
          <p className="text-sm leading-relaxed">
            The new key is created on the agent’s own machine and stays there. There is no way to
            send Haven a key, and there is no way to move one between machines — that is what
            keeps the account non-custodial.
          </p>
        </ApprovalRequiredBanner>
        <div>
          <label
            htmlFor="rekey-new-address"
            className="block text-sm font-medium text-[var(--v2-ink)]"
          >
            New signing address
          </label>
          <Input
            id="rekey-new-address"
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
            placeholder="0x…"
            className="mt-1.5 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          {newAddress.trim() !== '' && !addressValid ? (
            <p className="mt-1.5 text-sm text-[var(--v2-danger)]">
              {newAddress.trim().toLowerCase() === (currentDelegateAddress ?? '').toLowerCase()
                ? 'That is the address you are replacing. Paste the new one.'
                : 'That does not look like a wallet address.'}
            </p>
          ) : null}
        </div>
        {currentDelegateAddress ? (
          <p className="text-sm text-[var(--v2-ink-3)]">
            Replacing <Address value={currentDelegateAddress} />
          </p>
        ) : null}
      </div>
    )
  }

  function renderConsequences() {
    return (
      <div className="space-y-4">
        {resumed && rekey.resumeMode === 'stranded' ? (
          <ApprovalRequiredBanner title="An unfinished replacement is stuck" tone="danger">
            <p className="text-sm leading-relaxed">
              {agentName}’s old key was switched off by an earlier attempt that never finished,
              and that attempt cannot be picked up from where it stopped. The agent cannot pay
              until you set it a new budget.
            </p>
          </ApprovalRequiredBanner>
        ) : null}

        {resumed && rekey.resumeMode === 'resume' ? (
          <ApprovalRequiredBanner title="You already started replacing this key" tone="warning">
            <p className="text-sm leading-relaxed">
              Continuing finishes the replacement you started earlier, so the old key is already
              switched off and {agentName} cannot pay until this is done. It is tied to the
              signing address you gave then, which may not be the one you just entered.
            </p>
          </ApprovalRequiredBanner>
        ) : null}

        {residual ? (
          <ApprovalRequiredBanner title="There is money on the old signing address" tone="danger">
            <p className="text-sm leading-relaxed">
              The address you are retiring holds{' '}
              <strong className="font-medium">{formatUsdc(residual.atomic)} USDC</strong>. Moving
              it needs a signature from the <em>old</em> key. Once you replace that key the money
              stays there permanently — neither you nor Haven can move it afterwards.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => void runPreflight('swept')}>
                I moved it — continue
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void runPreflight('acknowledged_unrecoverable')}
              >
                Write it off and continue
              </Button>
            </div>
          </ApprovalRequiredBanner>
        ) : null}

        <div className="rounded-lg border border-[var(--v2-border)] p-4">
          <h4 className="text-sm font-medium text-[var(--v2-ink)]">What carries over</h4>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              The agent’s name, description and payment history — this is the same agent
              throughout.
            </li>
            <li>
              What is left of its budget, and the day its budget period rolls over. Replacing a
              key cannot hand an agent a bigger budget or a shorter period than it already had.
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-[var(--v2-border)] p-4">
          <h4 className="text-sm font-medium text-[var(--v2-ink)]">What stops working, immediately</h4>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <li>The old signing key and the old API key. Anything still using them will fail.</li>
            <li>
              Any payment the agent had quoted but not yet made. It will need to ask again with
              the new key.
            </li>
            <li>
              Every host running this agent needs its new credentials before it can pay again —
              restarting is not enough on its own.
            </li>
          </ul>
        </div>

        {/* ONE warning, not two (design review on #1701). These are both
            "things to know before you approve", and stacking them as separate
            same-weight banners in front of the red one flattened the severity
            signal — by the third coloured box a reader is pattern-matching
            "another notice" rather than escalating. The irreversible thing has
            to be the only banner on this screen that looks like an alarm. */}
        <ApprovalRequiredBanner title="Before you approve" tone="warning">
          <ul className="space-y-2.5 text-sm leading-relaxed">
            {hasAnchoredPassport ? (
              <li>
                <strong className="font-medium text-[var(--v2-ink)]">
                  The public record updates separately.
                </strong>{' '}
                {agentName}’s standing in Haven remains unchanged. Its current on-chain record will be
                retired and replaced with one naming the new signing address, so the dashboard may
                briefly show “Updating on-chain” after this finishes.
              </li>
            ) : null}
            <li>
              <strong className="font-medium text-[var(--v2-ink)]">
                Finish the remaining steps now.
              </strong>{' '}
              After the old key is switched off, {agentName} cannot pay while the replacement is
              unfinished. If a budget period rolls over before you finish, any remainder from the
              closed period is dropped. Any recurring budget that is still active continues on its
              existing schedule.
            </li>
          </ul>
        </ApprovalRequiredBanner>

        {gateOnScreen ? (
          <ApprovalRequiredBanner title="The next step cannot be undone" tone="danger">
            <p className="text-sm leading-relaxed">
              Approving switches off the old key on-chain straight away.{' '}
              <strong className="font-medium">{agentName} cannot pay anything</strong> from that
              moment until you finish the remaining steps — and if you stop in between, its budget
              is not restored and this cannot be restarted. Getting it running again would mean
              setting its budget up from scratch.
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              Up to here, nothing has changed and closing this is free.
            </p>
            <Checkbox
              className="mt-3"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              label={`I understand ${agentName} cannot pay until I finish, and that stopping partway means setting its budget up again.`}
            />
            {/* THE DESTRUCTIVE CONTROL LIVES HERE, not in the footer (#1887).
                The footer is sticky: it renders inside the modal's chrome and
                stays put while the body scrolls. That made "Switch off the old
                key" visible from the first paint of this step — above the
                passport disclosure, above the budget warning, above this
                banner, and above the checkbox that is supposed to gate it. At
                390px the body is ~2.7 screen-heights deep, so a phone user met
                the irreversible button roughly three screens before the
                sentence explaining what it costs, in the one place on a phone
                that is easiest to mis-tap.

                The gate was never weak — #1701 built it as a gate rather than
                a step on purpose. It just did not survive a narrow viewport,
                because a sticky footer is not below anything.

                So the BUTTON moved down; the warning did not move up and was
                not compressed. The banner and the acknowledgement are the
                gate, and shortening them to win vertical space would be
                trading away the thing being protected. Rendering the button as
                the last child of the banner makes the gate structural instead
                of merely adjacent: on any viewport, at any width, you cannot
                reach this control without having scrolled through the
                acknowledgement that enables it. `disabled` is unchanged — this
                is a position change, not a behaviour change. */}
            <div className="mt-4 flex">{destructiveButton()}</div>
          </ApprovalRequiredBanner>
        ) : null}
      </div>
    )
  }

  function renderSigning() {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          {signingLabel ?? 'Working…'}
        </p>
        <ApprovalRequiredBanner title="Do not close this" tone="danger" density="compact">
          <p className="text-sm leading-relaxed">
            {agentName}’s old key is being switched off. Leaving now stops the replacement
            partway, and its budget would have to be set up again from scratch.
          </p>
        </ApprovalRequiredBanner>
        {issuedDelegations.length > 0 ? (
          <p className="text-sm text-[var(--v2-ink-3)]">
            You will be asked to approve {issuedDelegations.length}{' '}
            {issuedDelegations.length === 1 ? 'budget rule' : 'budget rules'} — one signature each.
          </p>
        ) : null}
      </div>
    )
  }

  function renderStalled() {
    const stranded = !canRetry
    return (
      <div className="space-y-4">
        <ApprovalRequiredBanner title={`${agentName} cannot pay right now`} tone="danger">
          <p className="text-sm leading-relaxed">
            The old key is switched off and the replacement budget is not in place yet. That is
            the state this was always going to pass through — it just has not finished.
          </p>
        </ApprovalRequiredBanner>

        {stranded ? (
          <div className="rounded-lg border border-[var(--v2-border)] p-4">
            <h4 className="text-sm font-medium text-[var(--v2-ink)]">This cannot be finished here</h4>
            <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              The replacement stopped at a point it cannot be picked up from. Set a new budget for{' '}
              {agentName} to get it paying again, and contact support if it does not take.
            </p>
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Nothing was left half-applied by the attempt that failed, so trying again is safe.
            Finish now so the replacement can be completed and {agentName} can pay again.
          </p>
        )}
      </div>
    )
  }

  function renderDone() {
    if (!result) return null
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge tone="success">Done</StatusBadge>
          <span className="text-sm text-[var(--v2-ink-2)]">
            {agentName} has a new signing key.
          </span>
        </div>

        {/* Mirrors PaymentCredentialsModal's credential block rather than
            CredentialHandoffCard, which is the download-a-file shape. */}
        <div>
          <h4 className="text-sm font-medium text-[var(--v2-ink)]">New Haven credential</h4>
          <div className="mt-2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
            <code className="block break-all font-mono text-xs text-[var(--v2-ink-2)]">
              {result.api_key}
            </code>
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClick={() => void copyKey(result.api_key)}>
                {keyCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        <ApprovalRequiredBanner title="This key is shown once" tone="warning" density="compact">
          <p className="text-sm leading-relaxed">
            Put it on the machine that runs {agentName}, alongside the new signing key you
            generated there. The old API key stopped working the moment this finished.
          </p>
        </ApprovalRequiredBanner>

        <div className="rounded-lg border border-[var(--v2-border)] p-4">
          <h4 className="text-sm font-medium text-[var(--v2-ink)]">Where things stand</h4>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              New signing address: <Address value={result.new_delegate_address} copy />
            </li>
            {(result.invalidated_intents ?? 0) > 0 ? (
              <li>
                {result.invalidated_intents}{' '}
                {result.invalidated_intents === 1 ? 'payment was' : 'payments were'} cancelled
                before being made — the agent will need to ask again.
              </li>
            ) : null}
            {issuedDelegations.length > 0 ? (
              <li>
                {issuedDelegations.length}{' '}
                {issuedDelegations.length === 1 ? 'budget rule' : 'budget rules'} re-issued against
                the new key.
              </li>
            ) : null}
            {(result.residual_on_old_delegate?.atomic ?? '0') !== '0' ? (
              <li>
                {formatUsdc(result.residual_on_old_delegate?.atomic ?? '0')} USDC remains on the retired address and cannot
                be moved.
              </li>
            ) : null}
          </ul>
        </div>

        {issuedDelegations.length === 0 ? (
          <ApprovalRequiredBanner title="Check the agent’s budget" tone="warning">
            <p className="text-sm leading-relaxed">
              No replacement budget is active, so {agentName} cannot spend until you set a new
              budget.
            </p>
          </ApprovalRequiredBanner>
        ) : null}
        {issuedDelegations.length > 0 && skippedCount > 0 ? (
          <ApprovalRequiredBanner title="Check the agent’s budget" tone="neutral">
            <p className="text-sm leading-relaxed">
              Some old budget pieces were not re-issued because nothing remained or their time
              windows had closed. Active replacement budget rules were issued for the new key.
              Check the agent’s budget to confirm what is active now.
            </p>
          </ApprovalRequiredBanner>
        ) : null}
      </div>
    )
  }

  function renderFooter() {
    if (step === 'done') {
      return (
        <Button onClick={handleClose}>Done</Button>
      )
    }
    if (step === 'signing') {
      return <Button disabled>Working…</Button>
    }
    if (step === 'stalled') {
      return (
        <>
          <Button variant="ghost" onClick={handleClose} disabled={rekey.busy}>
            Close
          </Button>
          {canRetry ? (
            <Button onClick={() => void retry()} disabled={rekey.busy}>
              Try again
            </Button>
          ) : null}
        </>
      )
    }
    const cancel = (
      <Button variant="ghost" onClick={handleClose} disabled={rekey.busy || past}>
        Cancel
      </Button>
    )
    if (step === 'reason') {
      return (
        <>
          {cancel}
          <Button disabled={reason === null} onClick={() => setStep('address')}>
            Continue
          </Button>
        </>
      )
    }
    if (step === 'address') {
      return (
        <>
          <Button variant="ghost" onClick={() => setStep('reason')} disabled={rekey.busy}>
            Back
          </Button>
          <Button
            disabled={!addressValid || rekey.busy}
            onClick={() => void runPreflight()}
          >
            {rekey.busy ? "Checking…" : "Continue"}
          </Button>
        </>
      )
    }
    // consequences
    //
    // The footer carries the forward action ONLY when there is no gate on
    // screen for it to sit above (#1887). When the gate is rendered the button
    // is the banner's last child instead, so the footer is left holding the
    // one action that is always safe here — leaving. `stranded` has no forward
    // action at all, and `resume` is already past the revoke, so for both the
    // footer is still the right home.
    return (
      <>
        {cancel}
        {rekey.resumeMode === 'stranded' || gateOnScreen ? null : destructiveButton()}
      </>
    )
  }

  /**
   * The one control that spends the agent's authority.
   *
   * Rendered from exactly one place so its `disabled` predicate cannot drift
   * between the gate and the footer — the two positions differ in where they
   * sit on the page and in nothing else.
   */
  function destructiveButton() {
    return (
      <Button
        variant={rekey.resumeMode === 'resume' ? 'primary' : 'danger'}
        disabled={
          // A resumed re-key is already past the irreversible step, so
          // there is no gate left to acknowledge — requiring a checkbox
          // that is not rendered would dead-end the resume path.
          (rekey.resumeMode === 'full' && !acknowledged) ||
          rekey.busy ||
          Boolean(residual) ||
          Boolean(blocked)
        }
        onClick={() => void runRekey()}
      >
        {rekey.resumeMode === 'resume' ? 'Finish replacing the key' : 'Switch off the old key'}
      </Button>
    )
  }
}

function ReasonOption({
  value,
  selected,
  onSelect,
  title,
  body,
}: {
  value: Reason
  selected: boolean
  onSelect: (r: Reason) => void
  title: string
  body: string
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors ${
        selected
          ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)]'
          : 'border-[var(--v2-border)] hover:border-[var(--v2-border-strong)]'
      }`}
    >
      <input
        type="radio"
        name="rekey-reason"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        className="mt-0.5 h-4 w-4 accent-[var(--v2-brand)]"
      />
      <span>
        <span className="block text-sm font-medium text-[var(--v2-ink)]">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-[var(--v2-ink-2)]">{body}</span>
      </span>
    </label>
  )
}

export default ReplaceSigningKeyModal
