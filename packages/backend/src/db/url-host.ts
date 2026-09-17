/**
 * The ONE definition of "the host of a resource URL" (#3078, review S4/N3).
 *
 * The merchant layer keys merchants by host in two places — the backfill in
 * migration 088 (SQL) and `findOrCreateMerchantByHost` (SQL + the callers'
 * JavaScript) — and two definitions would silently found two merchants for
 * one row on the day they disagreed (userinfo, IDN). So the regex lives here,
 * once, and the JavaScript reader applies the SAME regex rather than
 * `new URL().hostname` (which punycodes an IDN the SQL side would not).
 *
 * Kept outside `infra/` and `db/migrations/` so both may import it without
 * a migration becoming a runtime dependency of the request path.
 */

/**
 * Capture group 1 is the host: scheme, optional userinfo, then everything up
 * to the first `/`, `:`, `?` or `#`. `FROM` is upper-cased because the
 * dependency-parity test reads `from '…'` as an import specifier.
 */
const HOST_PATTERN = '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/@?#]*@)?([^/:?#]+)'

/** The SQL expression for the lowercased host of `resource_url`, or NULL. */
export const HOST_OF_URL_SQL = `lower(substring(resource_url FROM '${HOST_PATTERN}'))`

const HOST_RE = new RegExp(HOST_PATTERN)

/** The lowercased host of a URL by the same rule as the SQL, or null. */
export function hostOfUrl(url: string): string | null {
  const match = HOST_RE.exec(url)
  if (!match || !match[1]) return null
  return match[1].toLowerCase()
}
