/**
 * The fetch wrapper's origin isolation, under test (#3515).
 *
 * The acceptance criterion — "with two environments configured, one
 * environment's token is never attached to the other's origin" — is exercised
 * against a fetch stub, so the rule is proven at the wrapper, not assumed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { opsFetch } from '../lib/api'
import { fileToken } from '../lib/token-store'

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

function jsonResponse(status: number): Response {
  return { ok: status < 400, status, json: async () => ({}) } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opsFetch', () => {
  it('attaches the token whose key equals the request origin', async () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'dev-token')
    fileToken(storage, PROD, 'prod-token')
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(`${String(url)}|${new Headers(init?.headers).get('Authorization') ?? ''}`)
      return jsonResponse(200)
    }) as unknown as typeof fetch)
    await opsFetch(`${DEV}/ops/me`, { storage })
    await opsFetch(`${PROD}/ops/me`, { storage })
    expect(seen).toEqual([
      `${DEV}/ops/me|Bearer dev-token`,
      `${PROD}/ops/me|Bearer prod-token`,
    ])
  })

  it('never attaches one environment token to the other origin', async () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'dev-token')
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Authorization') ?? '')
      return jsonResponse(200)
    }) as unknown as typeof fetch)
    await opsFetch(`${PROD}/ops/me`, { storage })
    expect(seen).toEqual([''])
  })

  it('drops the origin token and reports the 401 to the handler', async () => {
    const storage = fakeStorage()
    fileToken(storage, DEV, 'stale-token')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)) as unknown as typeof fetch)
    const unauthorized = vi.fn()
    await opsFetch(`${DEV}/ops/me`, { storage, unauthorized })
    expect(readTokenAfter(storage, DEV)).toBeNull()
    expect(unauthorized).toHaveBeenCalledWith(DEV)
  })
})

function readTokenAfter(storage: Storage, origin: string): string | null {
  return storage.getItem(`haven.ops.token.${origin}`)
}
