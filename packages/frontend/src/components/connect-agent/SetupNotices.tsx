'use client'

import type { ReactNode } from 'react'

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
