/**
 * The fragment half of the sign-in handoff (#3515, contract shared with #3509).
 *
 * The backend returns the browser to `<ops origin>/#token=<ops token>&nonce=<n>`
 * or `#error=<code>&nonce=<n>`. On return — before anything renders — the app
 * calls `history.replaceState(null, '', location.pathname + location.search)`
 * to scrub the fragment: the token must not sit in the address bar or history,
 * and a reload must not replay it.
 *
 * `consumeAuthFragment` does the scrub and the parse in one call, so a caller
 * cannot read the fragment without also scrubbing it.
 */

export type AuthFragment =
  | { kind: 'token'; token: string; nonce: string }
  | { kind: 'error'; error: string; nonce: string }
  | { kind: 'none' }

/** Parse a location hash (with or without the leading `#`). Pure. */
export function parseAuthFragment(hash: string): AuthFragment {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw === '') return { kind: 'none' }
  const params = new URLSearchParams(raw)
  const nonce = params.get('nonce') ?? ''
  const token = params.get('token')
  const error = params.get('error')
  if (token) return { kind: 'token', token, nonce }
  if (error) return { kind: 'error', error, nonce }
  return { kind: 'none' }
}

/**
 * Read the fragment out of the URL and scrub it, in that order. The scrub
 * happens even when the fragment is absent or unparseable — a URL that
 * carried junk should still come back clean.
 */
export function consumeAuthFragment(): AuthFragment {
  if (typeof window === 'undefined') return { kind: 'none' }
  const outcome = parseAuthFragment(window.location.hash)
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return outcome
}
