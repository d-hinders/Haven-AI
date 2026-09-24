/**
 * Is this send failure a DETERMINISTIC revert — the node executed the call and
 * the contract rejected it — rather than a transport problem? (#3263)
 *
 * The distinction decides whether an outbound row may ever succeed by being
 * retried unchanged. A revert with revert data (EAS `NotFound()`, a spent
 * EIP-3009 authorization, a CREATE2 deploy of an existing account) will revert
 * the same way on every later attempt, so retrying it only burns RPC quota:
 * on dev in 2026-09, 388 such orphans were re-sent every two minutes against a
 * relayer node already answering "request timeout on the free plan".
 * Everything else — timeouts, rate limits, 5xx, an ethers `could not coalesce`
 * wrapper around a provider error, nonce races — may clear on its own and keeps
 * the retry path.
 *
 * Deliberately narrow: ethers v6 `CALL_EXCEPTION` AND non-empty revert data.
 * A `CALL_EXCEPTION` with no data ("missing revert data") is also what some
 * providers produce for their own failures, so it is NOT treated as
 * deterministic — misreading a flaky node as a doomed payload would close a
 * row that could still have been sent.
 */
export function isDeterministicRevert(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, data } = err as { code?: unknown; data?: unknown }
  return code === 'CALL_EXCEPTION' && typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)
}

/**
 * A short, bounded, secret-free description of a deterministic revert for the
 * row's `error` column: the ethers action and the 4-byte selector of the
 * revert data (the custom error), never the full calldata.
 */
export function describeRevert(err: unknown): string {
  const { action, data } = (err ?? {}) as { action?: unknown; data?: unknown }
  const selector = typeof data === 'string' ? data.slice(0, 10) : 'unknown'
  const at = typeof action === 'string' ? action : 'call'
  return `reverted in ${at} (revert data ${selector})`
}
