'use client'

/**
 * The sign-in handoff, end to end (#3515).
 *
 * Start leg (`startSignIn`): generate a nonce, park `{nonce, backendOrigin}`
 * in sessionStorage, navigate to
 * `<backendOrigin>/ops/auth/github/start?return_to=<ops origin>&nonce=<n>`.
 *
 * Return leg (`useOpsSession`): on mount, before the first paint of any
 * authenticated content, consume the URL fragment (scrubbing it — see
 * lib/fragment-handoff.ts). A token is accepted only if its nonce matches
 * the pending handoff; it is then filed under the BACKEND ORIGIN and the
 * pending row is cleared. Every error code #3509 built surfaces as a
 * sign-in message:
 * `not_allowed`, `two_factor_required`, `github_denied`, `github_unavailable`,
 * `missing_code` — plus a mismatched-nonce return, which is refused.
 *
 * A 401 from any API call drops the token for that origin and returns the
 * user to sign-in (#3515) — `handleUnauthorized`, consumed by lib/api.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearPendingHandoff,
  clearAllTokens,
  fileToken,
  readPendingHandoff,
  readToken,
  writePendingHandoff,
} from './token-store'
import { consumeAuthFragment } from './fragment-handoff'

/** The error codes the #3509 backend can hand back in the fragment. */
export const SIGN_IN_ERRORS = [
  'not_allowed',
  'two_factor_required',
  'github_denied',
  'github_unavailable',
  'missing_code',
] as const

export type SignInErrorCode = (typeof SIGN_IN_ERRORS)[number]

/** Human copy for every code, plus the nonce-mismatch refusal. */
export function signInErrorMessage(code: string): string {
  switch (code) {
    case 'not_allowed':
      return 'This GitHub account is not on the allowlist for this console.'
    case 'two_factor_required':
      return 'This GitHub account does not have two-factor authentication enabled. Turn it on and try again.'
    case 'github_denied':
      return 'Sign-in was cancelled at GitHub. Nothing was signed in.'
    case 'github_unavailable':
      return 'GitHub could not complete the sign-in. Try again in a moment.'
    case 'missing_code':
      return 'GitHub did not hand back an authorization code. Try again.'
    case 'nonce_mismatch':
      return 'The sign-in return did not match the request this console sent. It was refused, so start again.'
    case 'unknown_error':
      return 'Sign-in returned an unrecognized error. Start again.'
    default:
      return 'Sign-in did not complete. Start again.'
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Begin a GitHub sign-in against `backendOrigin` (the selected environment's
 * origin). Parks the pending handoff and navigates the whole tab — the
 * backend answers with a fragment redirect, so this never returns in the
 * success path. `return_to` is THIS ops origin, verbatim: the backend
 * requires an exact `OPS_REDIRECT_ORIGINS` match (#3509).
 */
export function startSignIn(
  storage: Storage,
  backendOrigin: string,
  navigate: (url: string) => void,
): void {
  const nonce = randomNonce()
  writePendingHandoff(storage, { nonce, backendOrigin })
  const returnTo = window.location.origin
  navigate(
    `${backendOrigin}/ops/auth/github/start?return_to=${encodeURIComponent(returnTo)}&nonce=${encodeURIComponent(nonce)}`,
  )
}

export type SessionOutcome =
  | { state: 'ready' }
  | { state: 'signed-out'; error: string | null }

export interface OpsSession {
  /** Whether the session hook has finished reading (and scrubbing) the URL. */
  settled: boolean
  outcome: SessionOutcome
  /** Read the stored token for one backend origin. */
  tokenFor: (origin: string) => string | null
  /**
   * A 401 from a call to `origin`: drop that origin's token and return the
   * user to sign-in (#3515). The ONLY authorized handler components need.
   */
  onUnauthorized: (origin: string) => void
  /** Sign out: clear every environment's token. */
  signOut: () => void
}

/**
 * Consume the return fragment and expose the session. Mount this in the
 * client root, BEFORE anything renders authenticated content, so the fragment
 * is consumed before first paint and a reload can never replay a token.
 */
export function useOpsSession(storage: Storage): OpsSession {
  const [settled, setSettled] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)

  useEffect(() => {
    // StrictMode mounts effects twice in development; the fragment must be
    // consumed exactly once, and the first pass already scrubbed the URL.
    if (handled.current) {
      setSettled(true)
      return
    }
    handled.current = true

    const fragment = consumeAuthFragment()
    if (fragment.kind !== 'none') {
      const pending = readPendingHandoff(storage)
      clearPendingHandoff(storage)
      if (fragment.kind === 'token') {
        if (pending && fragment.nonce !== '' && fragment.nonce === pending.nonce) {
          fileToken(storage, pending.backendOrigin, fragment.token)
          setSignedIn(true)
        } else {
          // Nonce mismatch (or no pending handoff): refuse the token, whatever
          // it is. Nothing is filed; the URL was already scrubbed.
          setError(signInErrorMessage('nonce_mismatch'))
        }
      } else {
        setError(
          signInErrorMessage(
            (SIGN_IN_ERRORS as readonly string[]).includes(fragment.error)
              ? fragment.error
              : 'unknown_error',
          ),
        )
      }
    } else {
      setSignedIn(tokenOriginsCount(storage) > 0)
    }
    setSettled(true)
  }, [storage])

  const tokenFor = useCallback(
    (origin: string) => readToken(storage, origin),
    [storage],
  )

  const onUnauthorized = useCallback(
    (origin: string) => {
      storage.removeItem(`haven.ops.token.${origin}`)
      setSignedIn(false)
    },
    [storage],
  )

  const signOut = useCallback(() => {
    clearAllTokens(storage)
    setSignedIn(false)
  }, [storage])

  return {
    settled,
    outcome: settled && signedIn ? { state: 'ready' } : { state: 'signed-out', error },
    tokenFor,
    onUnauthorized,
    signOut,
  }
}

function tokenOriginsCount(storage: Storage): number {
  let count = 0
  for (let i = 0; i < storage.length; i++) {
    if (storage.key(i)?.startsWith('haven.ops.token.')) count++
  }
  return count
}
