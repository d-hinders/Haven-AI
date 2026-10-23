/**
 * Deterministic avatar tint for `Monogram` (#4066), and — since #4331 — the
 * agent's chart colour.
 *
 * Maps an entity's name to one of the six `--v2-avatar-*` tints. Pure
 * function of the name — same name, same tint, in light and dark, on every
 * render, with no theme or time input — so SSR and hydration agree, and the
 * `/marketplace` "AA"/"HS"/"BA" circles stay told apart at a glance.
 *
 * Normalisation matches `merchantInitials` (trim, then collapse runs of
 * whitespace), so a name's tint cannot depend on stray spacing.
 *
 * The hash is djb2 (times-33, 32-bit wrap) mod 6 — pinned deliberately:
 * FNV-1a mod 6 and a plain char-sum mod 6 each collide on a pair of the
 * marketplace fixture merchants, and the acceptance criteria require those
 * three to land on three different tints (asserted in
 * `src/lib/__tests__/avatar-tint.test.ts`). Assignment is by NAME, never by
 * index — an agent's colour must not move because its spend rank did — and
 * never from a status colour (hex disjointness from every status/semantic
 * hex, and from the `--v2-series-*` stops themselves, is asserted in
 * `theme-tokens.test.ts`).
 *
 * One colour per agent (#4331): the tint an agent's `Monogram` wears is the
 * SAME tint its chart series is filled with, via `seriesColorForAgent` below.
 * Two agents can hash to the same tint — six tints, unbounded agents — and
 * charts tell same-tint agents apart by name (legend, tooltip), not colour.
 */

const TINT_COUNT = 6

export function avatarTint(name: string): number {
  const normalised = name.trim().replace(/\s+/g, ' ')
  let hash = 5381
  for (let i = 0; i < normalised.length; i++) {
    hash = (Math.imul(hash, 33) + normalised.charCodeAt(i)) >>> 0
  }
  return (hash % TINT_COUNT) + 1
}

/**
 * The chart fill for an AGENT-keyed series (#4331): the agent's avatar tint,
 * the same token its `Monogram` initials wear. Every agent-keyed chart reads
 * this — never a rank-assigned `--v2-series-*` stop, which would repaint the
 * agent whenever its spend rank moved. The measured guarantee the fill
 * inherits (≥3:1 on both card grounds in both themes, inks pairwise
 * separable) is pinned in `CONTRAST_PAIRS` (`src/lib/theme-tokens.ts`).
 *
 * Not for series that are NOT an agent: those keep the ordered
 * `--v2-series-*` tokens (`seriesColor` in `ui/StackedBarChart.tsx`).
 */
export function seriesColorForAgent(name: string): string {
  return `var(--v2-avatar-${avatarTint(name)})`
}
