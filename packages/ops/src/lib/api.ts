/**
 * The ops API wrapper (#3515).
 *
 * ONE rule carries the whole origin-isolation contract: `opsFetch(url)` looks
 * up the token under the URL's OWN origin and attaches only that. A prod
 * token can never reach the dev backend, and vice versa — not because a
 * caller remembered to scope it, but because there is no other path.
 *
 * A 401 drops the origin's token HERE, before any handler runs: the credential
 * the backend refused must not survive the call, and "returns the user to
 * sign-in" (#3515) must not depend on a caller remembering to clear it.
 */
import { readToken, tokenKey } from './token-store'

export interface OpsFetchOptions extends RequestInit {
  /** The Storage holding the tokens. Production passes window.sessionStorage. */
  storage: Storage
  /** Called (origin) when the response is 401, after the token is dropped. */
  unauthorized?: (origin: string) => void
}

export function opsFetch(url: string, options: OpsFetchOptions): Promise<Response> {
  const { storage, unauthorized, ...init } = options
  const origin = new URL(url, window.location.origin).origin
  const token = readToken(storage, origin)
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...init, headers }).then((response) => {
    if (response.status === 401) {
      storage.removeItem(tokenKey(origin))
      unauthorized?.(origin)
    }
    return response
  })
}

export { tokenKey } from './token-store'
