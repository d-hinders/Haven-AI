/**
 * The ops API client (#3516).
 *
 * The write-surface contract lives HERE, as a type, not in a rule reviewers
 * remember: `OpsClient` exposes GET readers, `reveal` (`POST /ops/reveal`,
 * the one audited unmask) and `authStart` (the #3515 sign-in navigation).
 * There is no `post`, no `put`, no `delete`, no `patch` and no generic
 * `request(method, …)` to reach through — the test that pins this contract
 * (`__tests__/client.test.ts`) walks the client's own keys, so a method
 * added to the interface fails it before any review could miss the diff.
 *
 * Every reader is a typed helper over `opsFetch` (#3515): the origin-scoped
 * token attach and the 401 drop stay in that one wrapper. Errors are
 * returned, not thrown — every page owns its error state (the AC), and the
 * `kind` on a failure says which: `unavailable` is the deployment-level
 * answer an ops read gives when the read-only database or chain readers are
 * not configured (#3509/#3513), which pages render as "unavailable", not as
 * a crashed screen.
 */
import { opsFetch } from './api'
import type {
  OpsHealth,
  OpsMe,
  OpsOnchainView,
  OpsOverview,
  OpsRevealRequest,
  OpsRevealResponse,
  OpsSearchResponse,
  OpsUserDetail,
} from './ops-types'

/** A read that did not succeed, with the reason a page can branch on. */
export type OpsReadError =
  | { kind: 'unavailable'; status: number; message: string }
  | { kind: 'failed'; status: number; message: string }
  | { kind: 'network'; message: string }

export type OpsRead<T> = { ok: true; data: T } | { ok: false; error: OpsReadError }

function messageFor(status: number): string {
  if (status === 404) {
    return 'This deployment has no read-only ops database configured.'
  }
  if (status === 401 || status === 403) {
    return 'The console is not authorized for this read.'
  }
  if (status === 429) return 'Too many reads in a short time. Try again in a moment.'
  if (status >= 500) return 'The backend could not answer this read.'
  return `The read did not succeed (${status}).`
}

async function readJson<T>(response: Response): Promise<OpsRead<T>> {
  if (response.ok) {
    try {
      return { ok: true, data: (await response.json()) as T }
    } catch {
      return { ok: false, error: { kind: 'failed', status: response.status, message: 'The answer was not valid JSON.' } }
    }
  }
  return {
    ok: false,
    error: {
      kind: response.status === 404 ? 'unavailable' : 'failed',
      status: response.status,
      message: messageFor(response.status),
    },
  }
}

async function readText(response: Response): Promise<OpsRead<string>> {
  if (response.ok) {
    try {
      return { ok: true, data: await response.text() }
    } catch {
      return { ok: false, error: { kind: 'failed', status: response.status, message: 'The answer could not be read.' } }
    }
  }
  return {
    ok: false,
    error: {
      kind: response.status === 404 ? 'unavailable' : 'failed',
      status: response.status,
      message: messageFor(response.status),
    },
  }
}

/** The GET readers, the audited reveal and the sign-in navigation. Nothing else. */
export interface OpsClient {
  overview: () => Promise<OpsRead<OpsOverview>>
  search: (query: string) => Promise<OpsRead<OpsSearchResponse>>
  user: (id: string) => Promise<OpsRead<OpsUserDetail | null>>
  onchain: (userId: string) => Promise<OpsRead<OpsOnchainView | null>>
  health: () => Promise<OpsRead<OpsHealth>>
  docHealth: () => Promise<OpsRead<DocHealthJson>>
  me: () => Promise<OpsRead<OpsMe>>
  reveal: (request: OpsRevealRequest) => Promise<OpsRead<OpsRevealResponse>>
  /** The #3515 sign-in start: parks the handoff and navigates to GitHub. */
  authStart: (nonce: string) => void
}

/** `scripts/docs/doc-health.mjs`'s report shape (structural, for the panel). */
export interface DocHealthJson {
  generatedAt: string
  unverifiedDays: number
  notes: string[]
  total: number
  counts: Record<string, number>
  docs: { path: string; owner: string | null; status: string | null; lastVerified: string | null; flags: string[] }[]
}

export function createOpsClient(storage: Storage, origin: string, onUnauthorized: (origin: string) => void): OpsClient {
  const get = async <T>(path: string): Promise<OpsRead<T>> => {
    try {
      const response = await opsFetch(`${origin}${path}`, { storage, unauthorized: onUnauthorized })
      return await readJson<T>(response)
    } catch {
      return { ok: false, error: { kind: 'network', message: 'The console could not reach the backend.' } }
    }
  }

  return {
    overview: () => get<OpsOverview>('/ops/overview'),
    search: (query) => {
      // The backend detects the key type from the raw term (#3512); nothing
      // is normalized here — a mangled UUID is the customer's problem to
      // re-paste, not ours to repair.
      const params = new URLSearchParams({ q: query })
      return get<OpsSearchResponse>(`/ops/search?${params.toString()}`)
    },
    user: (id) => get<OpsUserDetail | null>(`/ops/users/${encodeURIComponent(id)}`),
    onchain: (userId) => get<OpsOnchainView | null>(`/ops/users/${encodeURIComponent(userId)}/onchain`),
    health: () => get<OpsHealth>('/ops/health'),
    // The doc-health JSON is a build-time static file (#3511); `same-origin`
    // reads it from THIS deployment, and a missing build wrote nothing.
    docHealth: async () => {
      try {
        const response = await fetch('/ops-doc-health.json', { headers: { accept: 'application/json' } })
        return await readJson<DocHealthJson>(response)
      } catch {
        return { ok: false, error: { kind: 'network', message: 'The console could not read the doc-health report.' } }
      }
    },
    me: () => get<OpsMe>('/ops/me'),
    reveal: async (request) => {
      try {
        const response = await opsFetch(`${origin}/ops/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          storage,
          unauthorized: onUnauthorized,
        })
        return await readJson<OpsRevealResponse>(response)
      } catch {
        return { ok: false, error: { kind: 'network', message: 'The console could not reach the backend.' } }
      }
    },
    authStart: () => {
      // The navigation itself is `startSignIn` (#3515, lib/ops-session.ts) —
      // the client only ever reaches it through the session, so this helper
      // exists so SignInView needs no second import surface.
      throw new Error('authStart is reached through the session (startSignIn), not the API client')
    },
  }
}
