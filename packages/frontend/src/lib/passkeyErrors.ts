/**
 * The ONE passkey-cancellation predicate (#1079, defect 3 — the #1076
 * regression).
 *
 * A dismissed Face ID / passkey sheet must never render as a failure. The
 * real error the WebAuthn path throws is ox's `SignFailedError` ("Failed to
 * request credential. Details: … NotAllowedError …") wrapping a DOMException
 * named `NotAllowedError` as its `cause` — substring checks for
 * 'rejected'/'denied' at the top level never see it. This predicate walks the
 * error AND its whole `cause` chain, so it recognises the cancellation no
 * matter how many layers (viem, the smart-accounts kit, our own wrappers)
 * re-wrap it.
 *
 * Matched shapes, at any depth of the cause chain:
 * - a DOMException (or any error) named `NotAllowedError` — the browser's
 *   one canonical "user did not complete the ceremony" signal;
 * - ox's SignFailedError (name ends in `SignFailedError` — it is namespaced,
 *   e.g. 'Authentication.SignFailedError' / 'WebAuthnP256.SignFailedError'
 *   across ox versions);
 * - names/messages matching /not.?allowed|cancel|denied|abort/i, which covers
 *   our own PasskeyCancelledError, AbortError, and wallet-style copy.
 */

const CANCELLATION_RE = /not.?allowed|cancel|denied|abort/i

export function isPasskeyCancellation(err: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = err

  while (current !== null && current !== undefined && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)

    const name = typeof (current as { name?: unknown }).name === 'string'
      ? (current as { name: string }).name
      : ''
    const message = typeof (current as { message?: unknown }).message === 'string'
      ? (current as { message: string }).message
      : ''

    if (name === 'NotAllowedError') return true
    // ox namespaces the class name ('Authentication.SignFailedError'); a
    // failed credential request on the sign path is a dismissed/blocked
    // ceremony, not a Haven failure.
    if (name.endsWith('SignFailedError')) return true
    if (CANCELLATION_RE.test(name) || CANCELLATION_RE.test(message)) return true

    current = (current as { cause?: unknown }).cause
  }

  return false
}
