/**
 * Agent label palette (#3167) — the ONE list of colours a label can carry.
 *
 * The backend validates `color` against it and the frontend renders it as a
 * (name → CSS variable) map, so the two cannot drift: a colour the API accepts
 * is a colour the UI knows how to paint, and a colour the UI paints is a
 * colour the API accepted.
 *
 * Every entry maps to an existing v2 token PAIR in
 * `packages/frontend/src/app/globals.css` (`--v2-*-soft` fill, `--v2-*` text /
 * strong border). No raw hex lives here or at the call sites — the
 * design-lint blocks raw hex in components, and more importantly the label
 * chips must flip with dark mode the same way every other tinted surface
 * does (#2927), which only the token pairs do.
 *
 * The palette deliberately EXCLUDES `--v2-warning` and `--v2-danger`: the
 * design system scopes those to their meanings (402/pending review, refusal,
 * destructive action) and a category chip is none of them — a "prod" label in
 * the danger tint would read as a failing agent. Four hues is also the honest
 * answer to "how many": labels are ad-hoc words, and a colour per word
 * reinvents syntax highlighting where the name already carries the meaning.
 *
 * Display/categorization only: nothing in the delegation, budget, or
 * on-chain enforcement path reads a label or its colour.
 */
export const LABEL_COLORS = ['neutral', 'brand', 'success', 'debit'] as const

export type LabelColor = (typeof LABEL_COLORS)[number]

export const DEFAULT_LABEL_COLOR: LabelColor = 'neutral'

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === 'string' && (LABEL_COLORS as readonly string[]).includes(value)
}
