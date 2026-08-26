/**
 * Decode the on-chain revert reason out of a delegation-rail refusal (#2016).
 *
 * When a caveat enforcer rejects a redemption during gas estimation, the
 * backend returns 502 with the bundler's simulation error in `details`. The
 * enforcer's reason string is NOT plain text in there — it arrives as the
 * ABI-encoded `Error(string)` payload, hex, inside a much larger dump:
 *
 *   ...reason: 0x08c379a0…0034 4552433230506572696f645472616e73666572456e…
 *
 * which decodes to `ERC20PeriodTransferEnforcer:transfer-amount-exceeded`.
 * A scenario that greps `details` for the enforcer NAME therefore never
 * matches, and the tempting repair — asserting only on the 502 — is the
 * defect #2016 exists to remove: a bundler outage, an RPC blip and a policy
 * refusal all produce the same status code, so a status-only assertion cannot
 * tell "the budget stopped it" from "nothing was asked".
 *
 * This decodes instead of guessing, so the assertion names the enforcer.
 */

/** Every printable ASCII run of >= 8 chars hiding in the hex blobs of `details`. */
export function decodeRevertStrings(details: string): string[] {
  const out: string[] = []
  for (const blob of details.match(/[0-9a-fA-F]{40,}/g) ?? []) {
    const even = blob.slice(0, blob.length - (blob.length % 2))
    let ascii = ''
    for (let i = 0; i < even.length; i += 2) {
      ascii += String.fromCharCode(parseInt(even.slice(i, i + 2), 16))
    }
    for (const run of ascii.match(/[\x20-\x7e]{8,}/g) ?? []) out.push(run)
  }
  return out
}

/**
 * The caveat-enforcer rejection inside a delegation-rail 502, or `null` when
 * the refusal did not come from an enforcer.
 *
 * `null` is the informative answer: it means the request was refused for some
 * OTHER reason (bundler down, RPC unreachable, sponsorship exhausted), which a
 * budget-enforcement scenario must report as a failure rather than as proof.
 */
export function caveatEnforcerRejection(details: string | undefined): string | null {
  if (!details) return null
  const direct = details.match(/[A-Z][A-Za-z0-9]*Enforcer:[a-z0-9-]+/)
  if (direct) return direct[0]
  for (const decoded of decodeRevertStrings(details)) {
    const hit = decoded.match(/[A-Z][A-Za-z0-9]*Enforcer:[a-z0-9-]+/)
    if (hit) return hit[0]
  }
  return null
}
