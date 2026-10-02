/**
 * Ops token storage (#3515).
 *
 * Tokens live in `sessionStorage` ONLY — never a cookie, never `localStorage`
 * (the #3515 contract; pinned by `__tests__/source-guard.test.ts`, which fails
 * if this tree so much as names them). Every helper takes the `Storage` as a
 * parameter: production passes `window.sessionStorage`, tests pass a stub.
 *
 * Keys are `haven.ops.token.<origin>` — a token is filed UNDER ITS BACKEND
 * ORIGIN, never under an environment label, so the fetch wrapper can attach
 * only the token whose key equals the request's origin and a prod token can
 * never reach the dev backend (or vice versa).
 */

const TOKEN_KEY_PREFIX = 'haven.ops.token.'
export const PENDING_KEY = 'haven.ops.pending'

export function tokenKey(origin: string): string {
  return `${TOKEN_KEY_PREFIX}${origin}`
}

export function readToken(storage: Storage, origin: string): string | null {
  return storage.getItem(tokenKey(origin))
}

export function fileToken(storage: Storage, origin: string, token: string): void {
  if (origin === '') throw new Error('fileToken: origin is required')
  if (token === '') throw new Error('fileToken: token is required')
  storage.setItem(tokenKey(origin), token)
}

/** Every backend origin this session holds a token for. */
export function tokenOrigins(storage: Storage): string[] {
  const origins: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && key.startsWith(TOKEN_KEY_PREFIX)) origins.push(key.slice(TOKEN_KEY_PREFIX.length))
  }
  return origins
}

/** Sign-out clears EVERY environment's token (#3515). */
export function clearAllTokens(storage: Storage): void {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key && key.startsWith(TOKEN_KEY_PREFIX)) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

// ── The sign-in handoff's pending half ──────────────────────────────────────
// Before navigating to the backend the app parks `{nonce, backendOrigin}` in
// sessionStorage (#3515). The return leg reads it, matches the nonce, files
// the token under the ORIGIN and clears it — see lib/handoff.ts.

export interface PendingHandoff {
  nonce: string
  backendOrigin: string
}

export function writePendingHandoff(storage: Storage, pending: PendingHandoff): void {
  storage.setItem(PENDING_KEY, JSON.stringify(pending))
}

export function readPendingHandoff(storage: Storage): PendingHandoff | null {
  const raw = storage.getItem(PENDING_KEY)
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).nonce === 'string' &&
      typeof (value as Record<string, unknown>).backendOrigin === 'string'
    ) {
      const record = value as Record<string, string>
      return { nonce: record.nonce, backendOrigin: record.backendOrigin }
    }
  } catch {
    // Fall through: a corrupt row is no row.
  }
  return null
}

export function clearPendingHandoff(storage: Storage): void {
  storage.removeItem(PENDING_KEY)
}
