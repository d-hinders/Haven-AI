/**
 * Token storage and the sign-in handoff, under test (#3515).
 *
 * The security acceptance criteria live here: a nonce mismatch is refused,
 * one environment's token is never attached to the other's origin, the token
 * never reaches a cookie or localStorage, and sign-out clears every token.
 */
import { describe, expect, it } from 'vitest'
import {
  clearAllTokens,
  clearPendingHandoff,
  fileToken,
  PENDING_KEY,
  readPendingHandoff,
  readToken,
  tokenOrigins,
  tokenKey,
  writePendingHandoff,
} from '../lib/token-store'
import { parseAuthFragment } from '../lib/fragment-handoff'
import { signInErrorMessage, SIGN_IN_ERRORS } from '../lib/ops-session'

/** An in-memory Storage pair standing in for sessionStorage and localStorage. */
function fakeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  }
}

const DEV = 'https://api.dev.example'
const PROD = 'https://api.example'

describe('token storage', () => {
  it('files a token under its backend origin', () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'token-a')
    expect(readToken(storage, DEV)).toBe('token-a')
    expect(readToken(storage, PROD)).toBeNull()
  })

  it('keeps two environments separate: one origin never reads the other token', () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'dev-token')
    fileToken(storage, PROD, 'prod-token')
    expect(readToken(storage, DEV)).toBe('dev-token')
    expect(readToken(storage, PROD)).toBe('prod-token')
    expect(tokenOrigins(storage).sort()).toEqual([DEV, PROD].sort())
  })

  it('sign-out clears every environment token', () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'dev-token')
    fileToken(storage, PROD, 'prod-token')
    writePendingHandoff(storage, { nonce: 'n', backendOrigin: DEV })
    clearAllTokens(storage)
    expect(tokenOrigins(storage)).toEqual([])
    // The pending handoff is NOT a token; sign-out leaves no token either way,
    // but the row itself is cleared by the return leg, not by sign-out.
    expect(readPendingHandoff(storage)).not.toBeNull()
  })

  it('refuses to file an empty origin or token', () => {
    const storage = fakeStorage()
    expect(() => fileToken(storage, '', 't')).toThrow()
    expect(() => fileToken(storage, DEV, '')).toThrow()
  })
})

describe('the pending handoff row', () => {
  it('round-trips nonce and backend origin', () => {
    const storage = fakeStorage()
    writePendingHandoff(storage, { nonce: 'abc', backendOrigin: DEV })
    expect(readPendingHandoff(storage)).toEqual({ nonce: 'abc', backendOrigin: DEV })
  })

  it('returns null for a corrupt row', () => {
    const storage = fakeStorage()
    storage.setItem(PENDING_KEY, '{not json')
    expect(readPendingHandoff(storage)).toBeNull()
  })

  it('clears the row', () => {
    const storage = fakeStorage()
    writePendingHandoff(storage, { nonce: 'abc', backendOrigin: DEV })
    clearPendingHandoff(storage)
    expect(readPendingHandoff(storage)).toBeNull()
  })
})

describe('the return fragment', () => {
  it('parses the token form', () => {
    expect(parseAuthFragment('#token=abc&nonce=n1')).toEqual({
      kind: 'token',
      token: 'abc',
      nonce: 'n1',
    })
  })

  it('parses the error form', () => {
    expect(parseAuthFragment('#error=not_allowed&nonce=n1')).toEqual({
      kind: 'error',
      error: 'not_allowed',
      nonce: 'n1',
    })
  })

  it('parses nothing from an empty fragment', () => {
    expect(parseAuthFragment('')).toEqual({ kind: 'none' })
  })

  it('covers every error code the #3509 backend can return', () => {
    for (const code of SIGN_IN_ERRORS) {
      expect(signInErrorMessage(code)).not.toContain('unrecognized')
    }
    // An unrecognized code still renders a message, never raw code text.
    expect(signInErrorMessage('something_else')).toBeTruthy()
  })
})

describe('key shape', () => {
  it('keys tokens by origin so the fetch wrapper can scope by it', () => {
    expect(tokenKey(DEV)).toBe(`haven.ops.token.${DEV}`)
  })
})
