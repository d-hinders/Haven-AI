'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { StatusBadge, type StatusTone } from '../ui/StatusBadge'
import { restartCopyForRuntime } from './setup-copy'

/** Loading state while the connector finishes local setup. */
export function FinalizingLocalSetup({ loading: _loading }: { loading: boolean }) {
  // #1377 C: the label is static — polling must never swap it (content shift).
  // #1392: short state with no action — centre it within the reserved height.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
      <div className="flex justify-center">
        <StatusBadge tone="neutral">
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
          Finishing setup
        </StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">
        The connector is finishing local setup. This usually takes a few seconds.
      </p>
    </div>
  )
}

/** Terminal state (expired/cancelled/failed) with a restart + close action. */
export function TerminalSetupState({
  title,
  badgeLabel,
  body,
  tone,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}: {
  title: string
  badgeLabel: string
  body: string
  tone: StatusTone
  primaryLabel: string
  secondaryLabel: string
  onPrimary: () => void
  onSecondary: () => void
}) {
  // #1392: flex column fills the reserved height; the action row pins to its
  // floor so the buttons land where every other sub-state puts them.
  return (
    <div className="flex flex-1 flex-col gap-5 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-surface-2)]">
        <StatusBadge tone={tone}>{badgeLabel}</StatusBadge>
      </div>
      <div>
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      </div>
      <div className="mt-auto flex gap-3">
        <Button variant="ghost" onClick={onSecondary} className="flex-1">
          {secondaryLabel}
        </Button>
        <Button onClick={onPrimary} className="flex-1">
          {primaryLabel}
        </Button>
      </div>
    </div>
  )
}

/** Informational status (approval in progress / proposed / unknown). */
export function SetupStatusState({
  title,
  body,
  tone,
  primaryLabel,
  onPrimary,
}: {
  title: string
  body: string
  tone: StatusTone
  primaryLabel: string
  onPrimary: () => void
}) {
  return (
    <div className="flex flex-1 flex-col gap-5 text-center">
      <div className="flex justify-center">
        <StatusBadge tone={tone}>{title}</StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      <Button onClick={onPrimary} className="mt-auto w-full">
        {primaryLabel}
      </Button>
    </div>
  )
}

/** Success state after the agent rules are approved. */
export function SetupDoneState({
  runtime,
  skillInstalled,
  onClose,
}: {
  runtime: string
  skillInstalled: boolean
  onClose: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const restartCopy = restartCopyForRuntime(runtime)

  async function handleDownloadSkill() {
    setDownloading(true)
    try {
      const { buildSkillBundle } = await import('@/lib/agent-skill-bundle')
      const { blob, filename } = await buildSkillBundle()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  // #1392: the shell ticker already says Approved — no duplicate badge. The
  // outcome line leads, and Done pins to the reserved floor.
  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="mx-auto max-w-sm text-center text-sm font-medium leading-relaxed text-[var(--v2-ink)]">
        Your agent can now spend within budget.
      </p>
      <ul className="mx-auto max-w-sm space-y-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
        <li>✓ Haven tools wired into your agent environment</li>
        {skillInstalled ? (
          <li>✓ Haven payment skill installed</li>
        ) : (
          <li>
            <button
              type="button"
              onClick={handleDownloadSkill}
              disabled={downloading}
              className="text-[var(--v2-brand)] underline-offset-2 hover:underline disabled:opacity-50"
            >
              {downloading ? 'Preparing skill…' : 'Download the Haven payment skill'}
            </button>
            {' '}— a generic, secret-free guide your agent can load for payment best practice.
          </li>
        )}
        {restartCopy && <li>{restartCopy}</li>}
      </ul>
      <Button onClick={onClose} className="mt-auto w-full">
        Done
      </Button>
    </div>
  )
}
