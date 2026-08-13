'use client'

import type {
  CopyKind,
  CreateSetupResponse,
  ManualCredential,
} from '@/hooks/useAgentConnectionSetup'
import { Button } from '../ui/Button'
import { CopyBlock } from './CopyBlock'
import { InlineErrorNote } from './SetupNotices'
import { formatAbsoluteDate } from './setup-copy'

export function WaitingForConnector({
  setup,
  runtime,
  copied,
  onCopy,
  manualPathRevealed,
  onManualPathRevealedChange,
  manualFallbackConfirmed,
  onManualFallbackConfirmedChange,
  manualCredential,
  manualCredentialAcknowledged,
  manualCreating,
  manualError,
  onCreateManualCredential,
  onContinueAfterManualCredential,
  loading,
  error,
  connectionStalled,
  expiresAt,
  onCancel,
}: {
  setup: CreateSetupResponse
  runtime: string
  copied: CopyKind | null
  onCopy: (kind: CopyKind, value: string) => void
  manualPathRevealed: boolean
  onManualPathRevealedChange: (revealed: boolean) => void
  manualFallbackConfirmed: boolean
  onManualFallbackConfirmedChange: (confirmed: boolean) => void
  manualCredential: ManualCredential | null
  manualCredentialAcknowledged: boolean
  manualCreating: boolean
  manualError: string | null
  onCreateManualCredential: () => void
  onContinueAfterManualCredential: () => void
  loading: boolean
  error: string | null
  connectionStalled: boolean
  expiresAt: string
  onCancel: () => void
}) {
  return (
    <>
      {/* #1392: the shell ticker owns status — no per-sub-state badge. */}
      <div className="rounded-[10px] border border-[var(--v2-brand)]/15 bg-[var(--v2-brand-soft)] p-4">
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Connect your agent</h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          Paste this prompt into the agent environment. It includes your approval for the exact local setup actions, creates the key there, and sends Haven only the public signing address.
        </p>
        <p className="mt-2 text-xs font-medium leading-relaxed text-[var(--v2-ink)]">
          Haven advances this screen automatically once the agent connects — no refresh, nothing else to click here.
        </p>
        {runtime === 'codex-desktop' && (
          <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
            Codex Desktop may ask you to approve running the setup command. That is expected.
          </p>
        )}
      </div>

      <CopyBlock
        label="Setup prompt"
        value={setup.setup_prompt}
        copied={copied === 'prompt'}
        onCopy={() => onCopy('prompt', setup.setup_prompt)}
      />

      <details className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3 text-xs">
        <summary className="cursor-pointer text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
          Command fallback
        </summary>
        <div className="mt-3">
          <CopyBlock
            label="Local command"
            value={setup.connector_command}
            copied={copied === 'command'}
            onCopy={() => onCopy('command', setup.connector_command)}
          />
        </div>
      </details>

      <details className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3 text-xs">
        <summary className="cursor-pointer text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
          Manual credential fallback
        </summary>
        <div className="mt-3 space-y-3">
          <p className="leading-relaxed text-[var(--v2-ink-2)]">
            Use this only if the agent cannot run the setup command or store the local connector files. Haven will still receive only the public signing address and API key hash.
          </p>
          {!manualPathRevealed && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onManualPathRevealedChange(true)}
              className="w-full"
            >
              I really can't run the connector — show the manual path
            </Button>
          )}
          {manualPathRevealed && (<>
          <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-3">
            <p className="font-semibold text-[var(--v2-ink)]">Before creating a manual credential</p>
            <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed text-[var(--v2-ink-2)]">
              <li>Use it only in a trusted agent workspace.</li>
              <li>The private signing key lets the agent sign payments within the approved agent budget.</li>
              <li>The API key identifies the agent but cannot spend alone.</li>
              <li>If it may have leaked, pause or revoke the agent in Haven.</li>
              <li>Do not commit it, upload it, or paste it into shared logs.</li>
            </ul>
          </div>
          <label className="flex items-start gap-2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3 text-[var(--v2-ink-2)]">
            <input
              type="checkbox"
              checked={manualFallbackConfirmed}
              onChange={(event) => onManualFallbackConfirmedChange(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand this fallback shows a one-time private signing key and should only be pasted into a trusted agent workspace.
            </span>
          </label>
          {manualError && <InlineErrorNote>{manualError}</InlineErrorNote>}
          {!manualCredential && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCreateManualCredential}
              disabled={!manualFallbackConfirmed || manualCreating}
              className="w-full"
            >
              {manualCreating ? 'Creating manual credential...' : 'Create manual credential'}
            </Button>
          )}
          {manualCredential && (
            <div className="space-y-3">
              <CopyBlock
                label="Manual credential prompt"
                value={manualCredential.prompt}
                copied={copied === 'manual'}
                onCopy={() => onCopy('manual', manualCredential.prompt)}
              />
              {!manualCredentialAcknowledged && (
                <Button onClick={onContinueAfterManualCredential} className="w-full">
                  Continue to wallet approval
                </Button>
              )}
            </div>
          )}
          </>)}
        </div>
      </details>

      {/* Reserved from the first render so the bounded recovery state does not
          change the Step 4 silhouette while polling (#1379). #1392 moved the
          slot here from between the callout and the Setup prompt card — the
          empty reservation was the "~140px void" splitting two related blocks;
          next to the action zone the slack reads as breathing room, and the
          recovery affordances land beside the actions when the slot fills.
          Mobile stacks the two touch-sized actions; wider layouts keep one row. */}
      <div className="min-h-[216px] sm:min-h-[144px]" aria-live="polite">
        {connectionStalled && (
          <div className="rounded-[10px] border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] p-3 text-xs text-[var(--v2-ink-2)]">
            <p className="font-semibold text-[var(--v2-ink)]">Haven has not received a connection yet</p>
            <p className="mt-1 leading-relaxed">
              This setup is still waiting. Do not approve the agent rules yet. Run the same local command again, or cancel it and create a fresh setup prompt.
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

      {/* #1377 C: fixed-height slot — the error suffix must not reflow on a
          poll tick. Two reserved lines cover the longest content. */}
      <p className="min-h-8 text-xs text-[var(--v2-ink-3)]">
        Expires {formatAbsoluteDate(expiresAt)}.{' '}
        {error ? `Status check failed: ${error}` : 'Haven keeps checking in the background.'}
      </p>

      {/* #1392: copying the prompt IS the next step — it gets the primary
          slot; aborting is quiet. Cancel stays a real <button> for the
          existing role-based queries. */}
      <Button onClick={() => onCopy('prompt', setup.setup_prompt)} className="w-full">
        {copied === 'prompt' ? 'Copied to clipboard' : 'Copy setup prompt'}
      </Button>
      <button
        type="button"
        onClick={onCancel}
        className="mx-auto block text-xs text-[var(--v2-ink-3)] underline-offset-2 transition-colors hover:text-[var(--v2-ink)] hover:underline"
      >
        Cancel setup
      </button>
    </>
  )
}
