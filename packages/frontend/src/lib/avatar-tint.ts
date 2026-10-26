/**
 * Deterministic avatar tint for `Monogram` (#4066), and — since #4331 — the
 * agent's chart colour.
 *
 * Maps an entity to one of the six `--v2-avatar-*` tints. For a MERCHANT or a
 * CONTACT that is a pure function of the name — same name, same tint, in light
 * and dark, on every render, with no theme or time input — so SSR and
 * hydration agree, and the `/marketplace` "AA"/"HS"/"BA" circles stay told
 * apart at a glance.
 *
 * An AGENT does not rely on the hash (#4428): it carries a STORED tint
 * (`agents.avatar_tint`, migration 121), assigned at creation and unique among
 * the user's first six agents, so two agents whose names hash alike still wear
 * different colours. `resolveAvatarTint` prefers the stored tint and falls back
 * to the hash only when there is none — which is every merchant and contact,
 * and any agent row that predates the field.
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
 * Six tints, unbounded agents: past the first six a tint repeats (the one the
 * fewest of the user's agents hold, lowest number on ties), and charts tell
 * same-tint agents apart by name (legend, tooltip).
 */

const TINT_COUNT = 6

/** The six avatar tints, 1..6. */
export type AvatarTint = 1 | 2 | 3 | 4 | 5 | 6

export function avatarTint(name: string): AvatarTint {
  const normalised = name.trim().replace(/\s+/g, ' ')
  let hash = 5381
  for (let i = 0; i < normalised.length; i++) {
    hash = (Math.imul(hash, 33) + normalised.charCodeAt(i)) >>> 0
  }
  return ((hash % TINT_COUNT) + 1) as AvatarTint
}

/**
 * The tint an entity wears: its STORED tint when it has one (an agent), the
 * name hash otherwise (a merchant or a contact). The one place the rule lives
 * — `Monogram` and `seriesColorForAgent` both read it, so a monogram and its
 * chart swatch cannot disagree.
 *
 * A stored value outside 1..6 is not a tint (the column's CHECK forbids it, so
 * this is a wire-shape guard, not a policy): it falls back to the hash rather
 * than rendering an undefined class.
 */
export function resolveAvatarTint(entity: { name: string; avatarTint?: number | null }): AvatarTint {
  const stored = entity.avatarTint
  if (stored != null && Number.isInteger(stored) && stored >= 1 && stored <= TINT_COUNT) {
    return stored as AvatarTint
  }
  return avatarTint(entity.name)
}

/**
 * The chart fill for an AGENT-keyed series (#4331): the agent's avatar tint,
 * the same token its `Monogram` initials wear. Every agent-keyed chart reads
 * this — never a rank-assigned `--v2-series-*` stop, which would repaint the
 * agent whenever its spend rank moved. Since #4428 it takes the AGENT, not a
 * bare name: the stored tint wins over the hash, so two agents whose names
 * hash alike are drawn in different colours. The measured guarantee the fill
 * inherits (≥3:1 on both card grounds in both themes, inks pairwise
 * separable) is pinned in `CONTRAST_PAIRS` (`src/lib/theme-tokens.ts`).
 *
 * Not for series that are NOT an agent: those keep the ordered
 * `--v2-series-*` tokens (`seriesColor` in `ui/StackedBarChart.tsx`).
 */
export function seriesColorForAgent({
  name,
  avatarTint,
}: {
  name: string
  /** The agent's stored tint (`agents.avatar_tint`, 1..6); omit for the hash. */
  avatarTint?: number | null
}): string {
  return `var(--v2-avatar-${resolveAvatarTint({ name, avatarTint })})`
}
