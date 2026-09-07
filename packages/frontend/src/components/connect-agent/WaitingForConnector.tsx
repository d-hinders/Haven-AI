'use client'

import { useState } from 'react'
import type {
  CopyKind,
  CreateSetupResponse,
  ManualCredential,
} from '@/hooks/useAgentConnectionSetup'
import type { AwaitingConnectionStage } from '@/hooks/useAgentConnectionSetupStatus'
import { ChevronRight } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { CopyBlock } from './CopyBlock'
import { SegmentedControl } from './SegmentedControl'
import { InlineErrorNote } from './SetupNotices'
import { formatAbsoluteDate } from './setup-copy'

export function WaitingForConnector({
  setup,
  runtime,
  copied,
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

  return (
    <>
      {/* #1391: no status badge here. The shell ticker (Waiting → Connected →
          Approved) already says where you are, and saying it twice on one
          screen made neither instance authoritative. Status is the ticker's
          job; this block's job is what to DO. */}
      <div className="rounded-[10px] border border-brand/15 bg-[var(--v2-brand-soft)] p-4">
        {/* #1393 type scale: the modal has ONE title — the Modal primitive's
            own `text-sm font-semibold` (ui/Modal.tsx). Every heading inside
            the connect flow, including this one, plays a SECTION role and
            stays at this tier; none is promoted to compete with it. */}
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Connect your agent</h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          Paste this prompt into the agent environment. It includes your approval for the exact local setup actions, creates the key there, and sends Haven only the public signing address.
        </p>
        <p className="mt-2 text-xs font-medium leading-relaxed text-[var(--v2-ink)]">
          Haven advances this screen automatically once the agent connects — no refresh, nothing else to click here.
        </p>
        {/* #1672 review: the specific runtime is unknown until the connector
            reports, so the approval heads-up must show generically — a
            codex-desktop-only gate would render AFTER the user already faced
            the dialog.

            #1720 removed the gate entirely. It asked "is this the command
            path?" because snippet-path users were handed a config to paste
            rather than a command to run, and would never see an approval
            dialog. There is one command for every environment now, so the
            question has one answer and the heads-up is universal. The
            sharpening below still fires once the connector names the runtime
            — additive, and the only part that was ever runtime-specific. */}
        <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          {runtime === 'codex-desktop'
            ? 'Codex Desktop may ask you to approve running the connector command. That is expected.'
            : 'Your agent app may ask you to approve running the connector command. That is expected.'}
        </p>
      </div>

      {/* #1399: this slot ALWAYS says something. Reserving it for a recovery
          state that only ~never arrives left a 144-216px void on every run for
          the first minute — the reservation is now sized to the status line
          that is always there, and only the rare recovery block grows past it.
          The #1377 rule still holds where it matters: polling moves nothing,
          and the starting → slow transition changes words inside this reserved
          height. Both floors clear the LONGER (slow) string at their own
          content width with a line to spare (≈326px mobile / ≈536px from sm),
          deliberately, because the reviews disagreed on whether it wraps to
          two lines or three and jsdom cannot settle it — sizing for the worse
          case costs a few px of slack and removes the guess. Mobile stacks the
          two touch-sized recovery actions.

          #1391 revisited this with real screenshots: on desktop the floor is
          ~24px taller than the single line usually sitting in it, which reads
          as slack. It STAYS, deliberately. The slow string is ~87 characters
          against ~86 characters per line at this width — right on the wrap
          boundary, which is why two reviews disagreed about it and neither
          could settle it. A floor sized to one line would hold until the
          copy, the font, or the viewport moved by a hair, and then the
          starting → slow transition would jump. A few px of air is the price
          of a transition that provably never moves; that is the trade, not an
          oversight. */}
      <div className="min-h-16 sm:min-h-11" aria-live="polite">
        {connectionStage !== 'recovery' && (
          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            {connectionStage === 'slow'
              ? 'Still going — a first run downloads the connector first, so it can take a minute or two.'
              : 'Waiting for the agent to run the connector command. This usually takes a few seconds.'}
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

      <CopyBlock
        label="Setup prompt"
        value={setup.setup_prompt}
        copied={copied === 'prompt'}
        onCopy={() => onCopy('prompt', setup.setup_prompt)}
        primary
      />

      {/* #1391: ONE recessive disclosure, not two full-width cards. Both of
          these are for paths most users never take — and one of them hands out
          a private signing key — so they should not carry the same weight as
          the prompt above. The manual path keeps its own nested disclosure:
          the dangerous route stays one click deeper than the harmless one.

          Design review: the first cut gave BOTH disclosures the Card recipe
          (rounded + border + bg-white + p-3), so nesting them stacked three
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
                label="Credential format"
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
          #2482 moved the manual credential to its own disclosure directly
          under the setup prompt, so this one keeps a single job — the
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

      {/* #1377 C: fixed-height slot — the error suffix must not reflow on a
          poll tick. Two reserved lines cover the longest content. */}
      <p className="min-h-8 text-xs text-[var(--v2-ink-3)]">
        Expires {formatAbsoluteDate(expiresAt)}.{' '}
        {error ? `Status check failed: ${error}` : 'Haven keeps checking in the background.'}
      </p>

      {/* #1391: this screen offers EXACTLY ONE cancel-the-setup action at any
          moment. In the recovery stage the warning block above owns it
          ("Cancel this setup"), where it is both visible and warranted; here
          it is a small ghost button — centered, not full-width — because an
          exit should be findable without competing with the action that moves
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
      {connectionStage !== 'recovery' && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel setup
          </Button>
        </div>
      )}
    </>
  )
}
