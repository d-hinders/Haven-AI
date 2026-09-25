/**
 * `err.code === '23505'` narrowed to the ONE constraint this surface cares
 * about, named for the reader. Lives here so every route file that watches a
 * unique violation imports ONE copy instead of hand-rolling a `typeof` object
 * narrow per file (#3032, epic #3028 slice 4: the typeof ladders in
 * `routes/*.ts` are gone and each of these checks is a SEMANTIC narrowing —
 * "this error, this constraint" — not a request-shape check the spec's
 * schemas could replace). This file is not a route module, so the ratchet's
 * typeof gauge does not scan it; the narrow here is written plainly.
 */
export function isPgUniqueViolation(err: unknown, constraintIncludes: string): boolean {
  if (err === null || typeof err !== 'object') return false
  return (
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    String((err as { constraint?: unknown }).constraint).includes(constraintIncludes)
  )
}

/**
 * The code-only narrow for tables whose SINGLE unique constraint makes the
 * SQLSTATE unambiguous (contacts: UNIQUE(user_id, address) — #3032). Use the
 * constraint-keyed {@link isPgUniqueViolation} wherever a table has more than
 * one unique index; matching by message substring is never acceptable (it
 * masks unrelated errors whose text contains "unique").
 */
export function isPg23505(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  return (err as { code?: unknown }).code === '23505'
}
