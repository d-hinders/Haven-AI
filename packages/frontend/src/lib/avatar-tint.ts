/**
 * Deterministic avatar tint for `Monogram` (#4066).
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
 * index — the `--v2-series-*` order contract does not apply here — and never
 * from a status or series colour (hex disjointness is asserted in
 * `theme-tokens.test.ts`).
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
