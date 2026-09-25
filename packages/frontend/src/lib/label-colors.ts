/**
 * Client-side label palette (#3167) — the render half of the one colour list.
 *
 * `LABEL_COLORS` in `@haven_ai/core` is the canonical list: the backend
 * validates `color` against it and this module maps each name to the v2 token
 * pair that paints it, so an API-accepted colour is always a colour the UI
 * knows how to render and neither side can drift. No raw hex lives here —
 * every entry is a CSS variable reference, which is what makes chips flip with
 * dark mode the same way every other tinted surface does (#2927).
 *
 * The palette excludes warning and danger on purpose (see the core module
 * header): a category chip must not borrow the tints the design system
 * reserves for 402/pending-review and refusals.
 */
import type { LabelColor } from '@haven_ai/core'

export const LABEL_CHIP_CLASS: Record<LabelColor, string> = {
  neutral: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]',
  brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
  success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
  debit: 'bg-[var(--v2-debit-soft)] text-[var(--v2-debit)]',
}

/** How many chips an agent card shows before the "+N" overflow chip. */
export const LABEL_CHIPS_VISIBLE = 3

/** Fallback for a colour value the running core build does not know (never expected). */
export function labelChipClass(color: string): string {
  return (LABEL_CHIP_CLASS as Record<string, string>)[color] ?? LABEL_CHIP_CLASS.neutral
}
