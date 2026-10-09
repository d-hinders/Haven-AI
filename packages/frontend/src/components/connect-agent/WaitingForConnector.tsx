'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CopyKind,
  CreateSetupResponse,
  ManualCredential,
} from '@/hooks/useAgentConnectionSetup'
import type { AwaitingConnectionStage } from '@/hooks/useAgentConnectionSetupStatus'
import { ChevronRight, Copy, Lock } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { CODE_PREVIEW_CLASS, CopyBlock } from './CopyBlock'
import { ConnectSteps, type ConnectStepRow } from './ConnectSteps'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { InlineErrorNote } from './SetupNotices'
import { formatAbsoluteDate } from './setup-copy'

export function WaitingForConnector({
  setup,
  runtime,
  copied,
  promptCopied,
  keyMadeInBrowser,
  onCopy,
  manualCredential,
  manualCredentialAcknowledged,
  manualCreating,
  manualError,
  onCreateManualCredential,
  onContinueAfterManualCredential,
  loading,
  error,
  connectionStage,
  expiresAt,
  onCancel,
}: {
  setup: CreateSetupResponse
  runtime: string
  copied: CopyKind | null
  /**
   * #3832: LATCHED — true once the setup prompt has been copied in this
   * session. Row 1's done state reads this, never `copied`, which is
   * single-valued: copying the local command or the .env block overwrites it.
   */
  promptCopied: boolean
  /**
   * #3832: the delegate key is being (or was) made in the BROWSER — the
   * manual-credential path (#2482). The trust line ("your agent creates its
   * own key on its machine") is false there, so it does not render.
   */
  keyMadeInBrowser: boolean
  onCopy: (kind: CopyKind, value: string) => void
  manualCredential: ManualCredential | null
  manualCredentialAcknowledged: boolean
  manualCreating: boolean
  manualError: string | null
  onCreateManualCredential: () => void
  onContinueAfterManualCredential: () => void
  loading: boolean
  error: string | null
  connectionStage: AwaitingConnectionStage
  expiresAt: string
  onCancel: () => void
}) {
  // Which rendering of the manual credential is shown — .env by default;
  // selecting the format is pure presentation, so it stays local to this
  // component rather than riding the flow hook (#2482).
  const [manualFormat, setManualFormat] = useState<'env' | 'prompt'>('env')

  // Copying swaps row 1's primary for "Copy again" — the focused button
  // unmounts, which would drop keyboard focus to <body>. Hand it to the
  // control that replaced it, on the transition only (never on mount).
  const copyAgainRef = useRef<HTMLButtonElement>(null)
  const wasCopied = useRef(promptCopied)
  useEffect(() => {
    if (promptCopied && !wasCopied.current) copyAgainRef.current?.focus()
    wasCopied.current = promptCopied
  }, [promptCopied])

  // #2482: once the server-credential path has issued credentials, that path
  // is the user's next step (save them, then "Continue to wallet approval").
  // Row 1 must not keep a second full-width primary competing with it, and
  // row 3 must not promise "nothing else to click".
  const manualInProgress = Boolean(manualCredential)

  const promptRows: ConnectStepRow[] = [
    promptCopied
      ? {
          id: 'copy',
          state: 'done',
          title: 'Prompt copied',
          aside: (
            <Button
              ref={copyAgainRef}
              variant="ghost"
              size="sm"
              onClick={() => onCopy('prompt', setup.setup_prompt)}
            >
              <Icon icon={Copy} className="h-3.5 w-3.5" />
              Copy again
            </Button>
          ),
        }
      : {
          id: 'copy',
          state: 'active',
          title: 'Copy the setup prompt',
          children: (
            <>
              {/* #3832: the ONE full-width primary before copying. The prompt
                  itself is long and only matters to someone checking what
                  they hand their agent, so it sits behind a closed
                  disclosure instead of a 192px scrolling preview that
                  pushed this button down the screen. */}
              <Button
                variant={manualInProgress ? 'ghost' : 'primary'}
                size={manualInProgress ? 'sm' : 'lg'}
                className={manualInProgress ? 'self-start' : 'w-full'}
                onClick={() => onCopy('prompt', setup.setup_prompt)}
              >
                <Icon icon={Copy} className="h-4 w-4" />
                Copy setup prompt
              </Button>
              <details className="group text-xs">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
                  <Icon
                    icon={ChevronRight}
                    className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
                  />
                  View the prompt
                </summary>
                <div className="mt-3 border-l border-[var(--v2-border)] pl-3">
                  <pre className={CODE_PREVIEW_CLASS}>{setup.setup_prompt}</pre>
                </div>
              </details>
            </>
          ),
        },
    {
      id: 'paste',
      state: promptCopied ? 'active' : 'pending',
      title: 'Paste it into your agent',
      children: (
        // #1720: one command for every environment, so the approval heads-up
        // is universal; it sharpens only once the connector names the
        // runtime. "Connector command" is the canonical term
        // (copy-guidelines.md). No list of client names (#3832 owner
        // decision): any MCP client works, and a list says otherwise.
        <p className={`text-xs leading-relaxed ${promptCopied ? 'text-[var(--v2-ink-2)]' : 'text-[var(--v2-ink-3)]'}`}>
          Any agent app that supports MCP. When{' '}
          {runtime === 'codex-desktop' ? 'Codex Desktop' : 'it'} asks to run the connector command,
          approve it.
        </p>
      ),
    },
    {
      id: 'approve',
      // Pending until the prompt is out; then the row is in flight — the
      // user's part is done and Haven is the one waiting.
      state: promptCopied ? 'working' : 'pending',
      // #1684: the gate is named once per viewport. On this screen the
      // subtitle no longer names it, so this heading does.
      title: 'Approve the budget',
      children: (
        // #1399: this slot ALWAYS says something, and the starting → slow
        // transition changes words inside its reserved height. The floors
        // clear the longer (slow) string with a line to spare at this row's
        // content width — sized for the worse wrap on purpose (#1391: a floor
        // sized to one line jumps the moment copy or font moves). Recovery is
        // timer-driven, not copy-driven (useAgentConnectionSetupStatus), so it
        // surfaces here whether or not row 1 was ever marked copied.
        <div className="min-h-16 sm:min-h-11" aria-live="polite">
          {connectionStage !== 'recovery' && (
            <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
              {manualInProgress
                ? 'Save the credentials below, then continue to wallet approval.'
                : !promptCopied
                  ? 'Haven advances this screen automatically once your agent connects — nothing else to click here.'
                  : connectionStage === 'slow'
                  ? 'Still going — a first run downloads the connector first, so it can take a minute or two.'
                  : 'Waiting for your agent to run the connector command. This usually takes a few seconds.'}
            </p>
          )}
          {connectionStage === 'recovery' && (
            <div className="rounded-[10px] border border-warning/25 bg-[var(--v2-warning-soft)] p-3 text-xs text-[var(--v2-ink-2)]">
              <p className="font-semibold text-[var(--v2-ink)]">Haven has not received a connection yet</p>
              {/* #1720: the connector can refuse LOCALLY — it stops before
                  contacting Haven when it cannot work out which agent client to
                  configure — so this screen never hears about that failure and
                  cannot name it. What it must not do is give advice that is
                  wrong for it: "run the same command again" repeats the refusal
                  verbatim. Point at the connector's own output first, which
                  does name the problem and what to pass. */}
              <p className="mt-1 leading-relaxed">
                This setup is still waiting. Do not approve the budget yet. Check the connector&rsquo;s output first — if it stopped and asked for something, it says there what it needs. Otherwise run the same local command again, or cancel it and create a fresh setup prompt.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11"
                  onClick={() => onCopy('command', setup.connector_command)}
                >
                  Copy local command
                </Button>
                <Button variant="ghost" size="sm" className="min-h-11" onClick={onCancel}>
                  Cancel this setup
                </Button>
              </div>
            </div>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <ConnectSteps rows={promptRows} />

      {/* #3832: the one trust fact a cautious user needs before pasting,
          placed with the steps it is about. Only true on the connector path:
          the manual-credential path makes the key in this browser. */}
      {!keyMadeInBrowser && (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--v2-ink-3)]">
          <Icon icon={Lock} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Your agent creates its own key on its machine. Haven only receives its public address.</span>
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-[var(--v2-border)] pt-4">
        {/* #1391: ONE recessive disclosure, not two full-width cards. Both of
            these are for paths most users never take — and one of them hands out
            a private signing key — so they should not carry the same weight as
            the prompt above. The manual path keeps its own nested disclosure:
            the dangerous route stays one click deeper than the harmless one.

            Design review: the first cut gave BOTH disclosures the Card recipe
            (rounded + border + a white card fill + p-3), so nesting them stacked three
            identically-styled white boxes — a Card inside a Card inside a Card,
            which is the surface-hierarchy rule's "no nested filled cards" in its
            hand-rolled form (design-lint's structural rules only catch the
            `Card` primitive, so nothing flagged it). This flow already has a
            lighter convention for exactly this — chevron summary, left rule for
            the body, no box at all (ConnectionVerificationFooter) — so use it. Depth now reads from indentation
            instead of from stacked surfaces, and the only card left inside is
            the CopyBlock, which is genuinely one.

            #2482 lifts the manual path OUT of "Having trouble connecting?" —
            and out of the "one click deeper than the harmless one" rationale
            that nested it there. That rationale was written when the manual
            credential was only ever a fallback for a local runtime that
            failed. A server or hosted backend is not that: the connector command
            writes files under ~/.haven and edits a local MCP config, so it
            cannot run there at all, and the manual credential IS the supported
            integration path (it emits exactly the HAVEN_* values the SDK reads).
            Burying that path under a heading about a connection problem hid it
            from the developers it exists for.

            What #1391 still gets right is the DEFAULT ordering: the setup prompt
            above keeps its primacy and this stays a single recessive
            disclosure — this is a reframing, not a re-ranking. And the friction
            is gone: no reveal button, no warning panel, no acknowledgement
            checkbox. One plain intro says what you are about to get and that
            the signing key is shown once; the safety facts live at the result,
            beside the key, where they are actionable. The generate action still
            registers with connector_version 'browser-manual-fallback' so
            install_status.manual_credential_fallback keeps the flow able to
            reach the budget-approval step (#2472/#2475) — that wiring lives in
            useAgentConnectionSetup.handleCreateManualCredential and is covered
            by the hook tests. */}
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
            <Icon
              icon={ChevronRight}
              className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
            />
            Running in a server or hosted backend?
          </summary>
          <div className="mt-3 space-y-3 border-l border-[var(--v2-border)] pl-3">
            {!manualCredential ? (
              <>
                <p className="leading-relaxed text-[var(--v2-ink-2)]">
                  When your agent runs on a server or hosted backend, the connector command cannot run there. Paste these values into the backend&rsquo;s secrets instead — an API key that identifies your agent and a private signing key the runtime uses to sign payments. The signing key is shown once.
                </p>
                {manualError && <InlineErrorNote>{manualError}</InlineErrorNote>}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={onCreateManualCredential}
                  disabled={manualCreating}
                >
                  {manualCreating ? 'Creating credentials...' : 'Generate credentials'}
                </Button>
              </>
            ) : (
              <div className="space-y-3">
                <SegmentedControl
                  ariaLabel="Credential format"
                  options={[
                    { value: 'env', label: '.env' },
                    { value: 'prompt', label: 'Agent workspace prompt' },
                  ]}
                  value={manualFormat}
                  onChange={setManualFormat}
                />
                <CopyBlock
                  label={manualFormat === 'env' ? '.env block' : 'Agent workspace prompt'}
                  value={manualFormat === 'env' ? manualCredential.env : manualCredential.prompt}
                  copied={copied === 'manual'}
                  onCopy={() =>
                    onCopy(
                      'manual',
                      manualFormat === 'env' ? manualCredential.env : manualCredential.prompt,
                    )
                  }
                />
                <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                  The signing key is shown once. If it leaks, replace it from the agent page.
                </p>
                {!manualCredentialAcknowledged && (
                  <Button onClick={onContinueAfterManualCredential} className="w-full">
                    Continue to wallet approval
                  </Button>
                )}
              </div>
            )}
          </div>
        </details>

        {/* The local-command recovery path no longer hosts the manual route:
            #2482 moved the manual credential to its own disclosure (since
            #3832, the first one in the footer below the setup steps), so this one keeps a single job — the
            command to re-run when the connector did not connect. */}
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
            <Icon
              icon={ChevronRight}
              className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
            />
            Having trouble connecting?
          </summary>
          <div className="mt-3 space-y-3 border-l border-[var(--v2-border)] pl-3">
            <CopyBlock
              label="Local command"
              value={setup.connector_command}
              copied={copied === 'command'}
              onCopy={() => onCopy('command', setup.connector_command)}
            />
          </div>
        </details>

        {/* #1391: this screen offers EXACTLY ONE cancel-the-setup action at any
            moment. In the recovery stage the warning block above owns it
            ("Cancel this setup"), where it is both visible and warranted; here
            it is a small ghost button beside the expiry line, not full-width,
            because an exit should be findable without competing with the action that moves
            the user forward. (Called "a quiet link" in an earlier draft of this
            comment; it is not link-styled and never was.) It stays a
            <button>: demoting it visually must not demote it semantically, and
            the stage-conditional render below is pinned by a test, since a
            missing exit is worse than a loud one.

            Scope, since #1415 gave the modal chrome its own X: that X is
            handleClose — dismiss the dialog, leave the setup alive server-side
            to be resumed. This is handleCancelSetup — POST /cancel, the setup is
            over. Two exits, two outcomes; the "exactly once" rule is about the
            destructive one. Whether the difference is legible to a user from
            two unlabelled-vs-labelled affordances is a real question, and it
            belongs to the modal-chrome track (#1406), not here. */}

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {/* #1377 C: fixed-height slot — the error suffix must not reflow on
              a poll tick. Two reserved lines cover the longest content. */}
          <p className="min-h-8 min-w-0 flex-1 text-xs text-[var(--v2-ink-3)]">
            Expires {formatAbsoluteDate(expiresAt)}.{' '}
            {error ? `Status check failed: ${error}` : 'Haven keeps checking in the background.'}
          </p>
          {connectionStage !== 'recovery' && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel setup
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
