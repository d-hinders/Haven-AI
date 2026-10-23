/**
 * LIKE/ILIKE escaping for a free-text SUBSTRING search (#4346).
 *
 * A search term bound into `col ILIKE '%' || $n || '%'` is parameterised (no
 * injection), but LIKE still reads `%` and `_` in it as wildcards and `\` as
 * its escape character. So a term of `_` matched every row, and `a\b` matched
 * `ab` but not a literal `a\b`. The specs promise a case-insensitive substring
 * search, so the term must match literally.
 *
 * The contract between this helper and the SQL:
 * - the helper escapes `\`, `%` and `_` with a backslash;
 * - every predicate that binds its result declares `ESCAPE '\'`. Postgres's
 *   default LIKE escape is already `\`, so the clause changes no result today;
 *   it states the contract in the SQL text, where review can see it.
 *
 * `null` stays `null`, so the `($n::text IS NULL OR …)` short-circuit still
 * means "no search". The term is not lowercased: ILIKE is case-insensitive.
 *
 * `escapeLikePrefix` (`repositories/ops-reads.ts`) is the ops search's own
 * lowercased PREFIX form and stays separate.
 */
export function escapeLikeContains(term: string): string
export function escapeLikeContains(term: string | null): string | null
export function escapeLikeContains(term: string | null): string | null {
  if (term === null) return null
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}
