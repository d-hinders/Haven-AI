/**
 * x402 resource-URL hostname parsing — the single source of truth.
 *
 * Moved from `packages/frontend/src/lib/transaction-labels.ts` (#4332): the
 * analytics naming module (`packages/backend/src/modules/transactions/counterparty-name.ts`)
 * needs the SAME parse the frontend's `counterpartyLabel` uses — the x402
 * resource host is step 1 of the settled naming order (x402 host → own
 * account → contact → receipt → none) — so backend and frontend share one
 * definition instead of drifting.
 *
 * The behavior is the frontend's, verbatim: a truthy URL parses via `new
 * URL()` and yields its `hostname`; anything unparseable (or absent) is
 * `null`. No scheme allow-listing, no port stripping — `hostname` already
 * excludes both.
 */

/**
 * The hostname of an x402 resource URL, or `null` when it is absent or not a
 * parseable URL. `https://research.example/report?q=1` → `research.example`;
 * `'not a url'` → `null`.
 */
export function parseX402Hostname(resourceUrl?: string | null): string | null {
  if (!resourceUrl) return null

  try {
    return new URL(resourceUrl).hostname
  } catch {
    return null
  }
}
