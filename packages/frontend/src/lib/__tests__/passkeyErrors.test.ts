// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
// The REAL ox error class — the exact object the WebAuthn sign path throws
// (#1079, defect 3). ox is a direct dependency of viem, so this resolves in
// any environment the app itself builds in. Testing against hand-built
// lookalikes is precisely how the #1076 regression shipped.
import { SignFailedError } from 'ox/webauthn/Authentication'
import { isPasskeyCancellation } from '@/lib/passkeyErrors'

describe('isPasskeyCancellation', () => {
  it('matches a real DOMException named NotAllowedError', () => {
    const err = new DOMException(
      'The operation either timed out or was not allowed.',
      'NotAllowedError',
    )
    expect(isPasskeyCancellation(err)).toBe(true)
  })

  it('matches the real ox SignFailedError wrapping a NotAllowedError cause', () => {
    // This is what `WebAuthnP256.sign` actually throws when the user
    // dismisses the Face ID sheet: SignFailedError with the DOMException as
    // its `cause`.
    const err = new SignFailedError({
      cause: new DOMException(
        'The operation either timed out or was not allowed.',
        'NotAllowedError',
      ),
    })
    expect(err.name.endsWith('SignFailedError')).toBe(true)
    expect(isPasskeyCancellation(err)).toBe(true)
  })

  it('matches a bare ox SignFailedError (null credential) with no cause', () => {
    expect(isPasskeyCancellation(new SignFailedError())).toBe(true)
  })

  it('matches the ox error even when re-wrapped by another layer', () => {
    const inner = new SignFailedError({
      cause: new DOMException('Not allowed', 'NotAllowedError'),
    })
    const wrapped = new Error('Signing failed', { cause: inner })
    expect(isPasskeyCancellation(wrapped)).toBe(true)
  })

  it('matches our own PasskeyCancelledError-style names and AbortError', () => {
    const cancelledLike = Object.assign(new Error('user closed the sheet'), {
      name: 'PasskeyCancelledError',
    })
    expect(isPasskeyCancellation(cancelledLike)).toBe(true)
    expect(isPasskeyCancellation(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('matches wallet-style denial copy in messages', () => {
    expect(isPasskeyCancellation(new Error('User denied transaction signature'))).toBe(true)
    expect(isPasskeyCancellation(new Error('Request cancelled by user'))).toBe(true)
  })

  it('does NOT match ordinary failures', () => {
    expect(isPasskeyCancellation(new Error('fetch failed'))).toBe(false)
    expect(isPasskeyCancellation(new Error('execution reverted'))).toBe(false)
    expect(isPasskeyCancellation(new TypeError('x is not a function'))).toBe(false)
    expect(isPasskeyCancellation(null)).toBe(false)
    expect(isPasskeyCancellation(undefined)).toBe(false)
    expect(isPasskeyCancellation('denied')).toBe(false)
  })

  it('survives a cyclic cause chain', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(isPasskeyCancellation(a)).toBe(false)
  })
})
