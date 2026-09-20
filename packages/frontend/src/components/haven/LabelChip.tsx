'use client'

import type { ReactNode } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import { labelChipClass, LABEL_CHIPS_VISIBLE } from '@/lib/label-colors'
import { Checkbox } from '@/components/ui/Checkbox'

export type AgentLabel = ApiSchema<'Label'>

/**
 * One label chip — the pill an agent renders for each label it carries
 * (#3167). Same shape language as the card header's status pill
 * (`text-xs px-1.5 py-0.5 rounded-full`), painted from the v2 token pairs in
 * `lib/label-colors.ts` so dark mode flips it like every other tinted
 * surface (#2927). Display only; carries no action.
 */
export function LabelChip({
  label,
  className = '',
}: {
  label: AgentLabel
  className?: string
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded-full px-1.5 py-0.5 text-xs font-medium ${labelChipClass(label.color)} ${className}`}
    >
      {label.name}
    </span>
  )
}

/**
 * The chip row an agent surface shows: up to `LABEL_CHIPS_VISIBLE` chips,
 * then a "+N" overflow chip naming the count the row dropped. The +N chip is
 * a plain counter, not a control — the editor is where the full set is
 * visible and editable.
 *
 * Renders nothing when the agent carries no labels: an empty chip row is
 * spacing noise on every card in an unlabelled list.
 */
export function LabelChipRow({ labels }: { labels: AgentLabel[] }) {
  if (labels.length === 0) return null
  const visible = labels.slice(0, LABEL_CHIPS_VISIBLE)
  const overflow = labels.length - visible.length
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="agent-label-chips">
      {visible.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      {overflow > 0 ? (
        <span
          className="inline-flex items-center rounded-full bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-ink-3)]"
          title={labels.slice(LABEL_CHIPS_VISIBLE).map((l) => l.name).join(', ')}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Editor row for one label — the checkbox line in the tag editor and the
 * manager's picker. The shared `Checkbox` primitive owns the row (input +
 * label text as one click target, implicit association, #1741 ring); the
 * chip rides in as its `label` node so a picker row reads exactly like the
 * chip the agent will carry. `trailing` renders after the chip (manager
 * rename/recolor controls); `helper` renders under it.
 */
export function LabelOptionRow({
  label,
  checked,
  onToggle,
  trailing,
  helper,
}: {
  label: AgentLabel
  checked: boolean
  onToggle: () => void
  trailing?: ReactNode
  helper?: ReactNode
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={onToggle}
      aria-label={label.name}
      className="min-h-11 items-center rounded-md px-1 hover:bg-[var(--v2-surface-2)]"
      label={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <LabelChip label={label} />
          {trailing}
        </span>
      }
      helperText={helper}
    />
  )
}
