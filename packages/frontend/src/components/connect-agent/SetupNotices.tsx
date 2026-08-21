'use client'

import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Icon } from '../ui/Icon'

/**
 * Shared notice shapes for the connect-agent flow (#901 pattern absorption —
 * each of these appeared in several steps during the #989 extraction).
 */

/** Single-paragraph danger note (create/approval/manual errors). */
export function InlineErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
      {children}
    </div>
  )
}

/** Warning callout with a bold title, explanatory body, and optional actions. */
export function WarningCallout({
  title,
  body,
  children,
}: {
  title: string
  body: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-3">
      <p className="text-sm font-semibold text-[var(--v2-ink)]">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">{body}</p>
      {children}
    </div>
  )
}

/**
 * A single thing the user still has to DO, lifted out of whatever list it was
 * sitting in (#1684).
 *
 * Brand-soft rather than warning-soft on purpose: this is the next step, not
 * a risk. Amber here would cry wolf on a screen whose whole job is the calm
 * conclusion of the flow — but a ticked done-list is the wrong home for a
 * to-do, and the runtime restart is the one item that silently breaks setup
 * when it is skipped.
 */
export function ActionCallout({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-brand-soft)] p-3">
      <Icon icon={Info} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--v2-brand)]" />
      <p className="text-xs leading-relaxed text-[var(--v2-ink)]">{children}</p>
    </div>
  )
}
