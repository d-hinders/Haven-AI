'use client'

import { useState } from 'react'
import { Check, Download } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { StatusBadge, type StatusTone } from '../ui/StatusBadge'
import { describeBudgetGrant } from '@/lib/budget-period'
import { ActionCallout } from './SetupNotices'
import { restartCopyForRuntime } from './setup-copy'

/** Loading state while the connector finishes local setup. */
export function FinalizingLocalSetup({ loading: _loading }: { loading: boolean }) {
  // #1377 C: the label is static — polling must never swap it (content shift).
  // #1393: no local `space-y-*` wrapper — ConnectStepShell's body is a
  // `flex flex-col gap-5`, and that gap is the flow's only vertical rhythm,
  // so this renders as top-level siblings of the shell rather than a single
  // wrapped block with its own spacing. `text-center` moves onto the one
  // element that needs it now that the wrapper no longer supplies it.
  return (
    <>
      <div className="flex justify-center">
        <StatusBadge tone="neutral">
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />
          Finishing setup
        </StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-center text-sm leading-relaxed text-[var(--v2-ink-2)]">
        The connector is finishing local setup. This usually takes a few seconds.
      </p>
    </>
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
  // #1393: no local `space-y-*` — shell `gap-5` is the only rhythm (see
  // FinalizingLocalSetup above); `text-center` moves onto the title/body
  // group specifically. The title stays the section tier (text-sm
  // font-semibold): the modal has exactly one title, the Modal primitive's
  // own `text-sm font-semibold` (ui/Modal.tsx) — every heading inside the
  // connect flow plays a SECTION role, never a competing modal-title role.
  return (
    <>
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-surface-2)]">
        <StatusBadge tone={tone}>{badgeLabel}</StatusBadge>
      </div>
      <div className="text-center">
        <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={onSecondary} className="flex-1">
          {secondaryLabel}
        </Button>
        <Button onClick={onPrimary} className="flex-1">
          {primaryLabel}
        </Button>
      </div>
    </>
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
  // #1393: no local `space-y-*` — shell `gap-5` is the only rhythm.
  return (
    <>
      <div className="flex justify-center">
        <StatusBadge tone={tone}>{title}</StatusBadge>
      </div>
      <p className="mx-auto max-w-sm text-center text-sm leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      <Button onClick={onPrimary} className="w-full">
        {primaryLabel}
      </Button>
    </>
  )
}

/** Success state after the agent budget is approved. */
export function SetupDoneState({
  runtime,
  skillInstalled,
  agentName,
  budgets,
  walletName,
  chainId,
  onClose,
}: {
  runtime: string
  skillInstalled: boolean
  /** Agent name, for naming the authority concretely. Falls back when absent. */
  agentName?: string | null
  /** The granted budgets, straight from `setupStatus.agent_budget`. */
  budgets?: Array<{ allowance_amount: string; token_symbol: string; reset_period_min: number }>
  /** The wallet the agent spends FROM. */
  walletName?: string | null
  /** Chain of that wallet — needed to resolve token decimals. */
  chainId?: number | null
  onClose: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const restartCopy = restartCopyForRuntime(runtime)

  // #1394: name the authority the user just granted, in the same words the
  // connector uses in the agent's own terminal. "Your agent can now spend
  // within budget" told the user nothing they had not already approved.
  const grantedName = agentName?.trim() || null
  const grants = (budgets ?? []).map((budget) =>
    describeBudgetGrant(budget, chainId, { form: 'sentence' }),
  )
  const canNameGrant = grantedName != null && grants.length > 0 && Boolean(walletName?.trim())

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

  return (
    <>
      {/* #1394: this screen leads with a heading like every other sub-state.
          It used to go badge → body → list, which read as a fragment rather
          than the flow's conclusion. No StatusBadge here: the shell ticker
          says "Approved" and the header subtitle says what just happened —
          a third copy made none of them authoritative.

          #1684: ONE line, not a heading plus a sentence repeating its subject
          and verb ("X is ready to spend" / "X can now spend up to …"). The
          grant itself is the heading, so the amount and the wallet stay in
          the confirmation — deleting the sentence would have undone #1394.
          Width: no `max-w-sm` cap. The column is set by the `Done` button
          below (w-full inside a max-w-xl modal), and a 384px cap left the
          button overhanging everything above it by ~150px. */}
      <div className="text-center">
        {/* text-balance: this line is the money-clarity payoff, and its length
            depends on the agent name, the amount and the WALLET name — a
            rendered review caught "…from Operating wallet." stranding
            "wallet." alone on line two. Balancing spreads the break rather
            than leaving it to whichever names a user happens to have. */}
        <h3 className="text-balance text-sm font-semibold leading-relaxed text-[var(--v2-ink)]">
          {canNameGrant ? (
            <>
              {/* .v2-tabular on the amount: design-system.md asks for tabular
                  numerals on EVERY amount, and this line is the flow's
                  money-clarity payoff. Wrapping the whole grant phrase rather
                  than splitting the digits out is deliberate — tabular-nums
                  only affects figures, so the symbol and period ride along
                  harmlessly and the describer stays one string. */}
              {grantedName} can now spend up to{' '}
              <span className="v2-tabular">{grants.join(', ')}</span> from {walletName}.
            </>
          ) : (
            // Degrades whenever any part is missing — a half-named authority
            // ("can spend up to  from ") would be worse than the abstract one.
            'Your agent is ready to spend'
          )}
        </h3>
      </div>

      <ul className="space-y-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
        <li className="flex items-start gap-1.5">
          <Icon icon={Check} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]" />
          <span>Haven tools wired into your agent environment</span>
        </li>
        {skillInstalled ? (
          <li className="flex items-start gap-1.5">
            <Icon icon={Check} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]" />
            <span>Haven payment skill installed</span>
          </li>
        ) : (
          // Not a check: this one is an OFFER, not something that happened.
          // Ticking it would claim an install the user has not done.
          <li className="flex items-start gap-1.5">
            <Icon icon={Download} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--v2-ink-3)]" />
            <span>
              The Haven payment skill is a generic, secret-free guide your agent can load for
              payment best practice.
              {/* ghost, not tertiary: tertiary is transparent-on-white, which
                  rendered as stray bold text in the middle of a checklist
                  rather than a control. A border is what makes it read as
                  something you can press. Secondary weight is still correct —
                  "Done" below is the primary action. */}
              <span className="mt-2 block">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11"
                  onClick={handleDownloadSkill}
                  disabled={downloading}
                >
                  {downloading ? 'Preparing skill…' : 'Download the skill'}
                </Button>
              </span>
            </span>
          </li>
        )}
      </ul>

      {/* #1684: the restart is the only thing on this screen the user still
          has to DO, and it sat third in a ticked done-list at 12px/ink-3 —
          skip it and the tools never load, so setup looks silently broken.
          A to-do and a done-list do not share a list. */}
      {restartCopy && <ActionCallout>{restartCopy}</ActionCallout>}

      <Button onClick={onClose} className="w-full">
        Done
      </Button>
    </>
  )
}
