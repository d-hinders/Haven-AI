/**
 * The sign-in session hook, under test (#3515).
 *
 * Covers the acceptance criteria the acceptance harness names directly: a
 * nonce mismatch is refused (the token is NOT filed), a matching nonce files
 * the token under the backend origin, every #3509 error code renders as a
 * sign-in message, and the fragment is scrubbed from the URL before the
 * console renders (a reload cannot replay it).
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { signInErrorMessage, useOpsSession } from '../lib/ops-session'
import { PENDING_KEY, writePendingHandoff } from '../lib/token-store'

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

const OPS_ORIGIN = 'https://ops.example'
const BACKEND = 'https://api.example'

/** The signed-out error, or null — the discriminator the assertions need. */
function errorOf(outcome: ReturnType<typeof useOpsSession>['outcome']): string | null {
  return outcome.state === 'signed-out' ? outcome.error : null
}

/** Point window at the ops origin and land on it with a fragment. */
function arriveAt(fragment: string): void {
  window.history.replaceState(null, '', `${OPS_ORIGIN}/${fragment}`)
}

describe('useOpsSession — the return leg', () => {
  it('accepts a token whose nonce matches and files it under the backend origin', async () => {
    const storage = fakeStorage()
    writePendingHandoff(storage, { nonce: 'n1', backendOrigin: BACKEND })
    arriveAt('#token=abc&nonce=n1')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.outcome).toEqual({ state: 'ready' })
    expect(result.current.tokenFor(BACKEND)).toBe('abc')
    // The pending row is spent.
    expect(storage.getItem(PENDING_KEY)).toBeNull()
  })

  it('refuses a token whose nonce does not match — nothing is filed', async () => {
    const storage = fakeStorage()
    writePendingHandoff(storage, { nonce: 'n1', backendOrigin: BACKEND })
    arriveAt('#token=evil&nonce=n2')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.outcome.state).toBe('signed-out')
    // The refusal surfaces as human copy from the shared table, never the
    // raw code (the code is not user-facing; copy text lives in ops-session).
    expect(errorOf(result.current.outcome)).toBe(signInErrorMessage('nonce_mismatch'))
    expect(errorOf(result.current.outcome)).not.toBe('nonce_mismatch')
    expect(result.current.tokenFor(BACKEND)).toBeNull()
    expect(storage.getItem(PENDING_KEY)).toBeNull()
  })

  it('refuses a token when no sign-in was started at all', async () => {
    const storage = fakeStorage()
    arriveAt('#token=evil&nonce=n1')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.outcome.state).toBe('signed-out')
    // Same contract as the mismatch case: human copy, never the raw code.
    expect(errorOf(result.current.outcome)).toBe(signInErrorMessage('nonce_mismatch'))
    expect(errorOf(result.current.outcome)).not.toBe('nonce_mismatch')
    expect(result.current.tokenFor(BACKEND)).toBeNull()
  })

  it('surfaces every #3509 error code as a sign-in message', async () => {
    for (const code of ['not_allowed', 'two_factor_required', 'github_denied', 'github_unavailable', 'missing_code']) {
      const storage = fakeStorage()
      writePendingHandoff(storage, { nonce: 'n1', backendOrigin: BACKEND })
      arriveAt(`#error=${code}&nonce=n1`)
      const { result } = renderHook(() => useOpsSession(storage))
      await waitFor(() => expect(result.current.settled).toBe(true))
      expect(result.current.outcome.state).toBe('signed-out')
      // The message is the human copy for THAT code, never the raw code.
      expect(errorOf(result.current.outcome)).toBe(signInErrorMessage(code))
      expect(errorOf(result.current.outcome)).not.toBe(code)
    }
  })

  it('scrubs the fragment before rendering — a reload cannot replay it', async () => {
    const storage = fakeStorage()
    writePendingHandoff(storage, { nonce: 'n1', backendOrigin: BACKEND })
    arriveAt('#token=abc&nonce=n1')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(window.location.hash).toBe('')
    expect(window.location.pathname + window.location.search).toBe('/')
    // A second mount (the reload) sees no fragment and no pending row.
    const second = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(second.result.current.settled).toBe(true))
    expect(second.result.current.outcome.state).toBe('ready') // token already filed
    expect(second.result.current.tokenFor(BACKEND)).toBe('abc')
  })

  it('drops to signed-out when a 401 arrives, via onUnauthorized', async () => {
    const storage = fakeStorage()
    storage.setItem(`haven.ops.token.${BACKEND}`, 'stale')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.outcome.state).toBe('ready')
    act(() => result.current.onUnauthorized(BACKEND))
    expect(result.current.outcome.state).toBe('signed-out')
    expect(result.current.tokenFor(BACKEND)).toBeNull()
  })

  it('sign-out clears every environment token', async () => {
    const storage = fakeStorage()
    storage.setItem(`haven.ops.token.${BACKEND}`, 'a')
    storage.setItem('haven.ops.token.https://api.dev.example', 'b')
    const { result } = renderHook(() => useOpsSession(storage))
    await waitFor(() => expect(result.current.settled).toBe(true))
    act(() => result.current.signOut())
    expect(result.current.tokenFor(BACKEND)).toBeNull()
    expect(result.current.tokenFor('https://api.dev.example')).toBeNull()
    expect(result.current.outcome.state).toBe('signed-out')
  })
})
