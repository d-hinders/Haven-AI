/**
 * The ops API client's write-surface contract (#3516 AC) and read behaviour.
 *
 * The client exposes ONLY GET readers, `POST /ops/reveal` and auth. There is
 * no generic method escape hatch — pinned by walking the client's OWN keys,
 * so a new method on the interface fails here before review could miss it.
 * A `POST /ops/reveal` requirement is pinned by asserting the one write goes
 * out as POST with a JSON body, and that GET helpers never send one.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createOpsClient, type OpsClient } from '../lib/ops-client'

const ORIGIN = 'https://api.dev.example'

function stubStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => void map.clear(),
  }
}

const fetchMock = vi.fn<typeof fetch>()

describe('the ops client exposes only reads, the audited reveal, and auth (#3516)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('the client surface is exactly the declared readers plus reveal and authStart', () => {
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    // The KEYS of the client are the write-surface contract: GET helpers,
    // POST /ops/reveal, and the sign-in navigation. Nothing else may appear,
    // because anything here is one call away from an unaudited write.
    expect(Object.keys(client).sort()).toEqual(
      ['authStart', 'docHealth', 'feedback', 'health', 'me', 'onchain', 'overview', 'reveal', 'search', 'user'].sort(),
    )
  })

  it('every reader issues a GET without a body to the selected origin', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    await client.overview()
    await client.feedback()
    await client.user('u-1')
    await client.onchain('u-1')
    await client.health()
    await client.me()
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET', body: init?.body }))
    for (const call of calls) {
      expect(call.url.startsWith(`${ORIGIN}/ops/`), call.url).toBe(true)
      expect(call.method).toBe('GET')
      expect(call.body).toBeUndefined()
    }
    expect(calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/ops/overview`,
      `${ORIGIN}/ops/feedback`,
      `${ORIGIN}/ops/users/u-1`,
      `${ORIGIN}/ops/users/u-1/onchain`,
      `${ORIGIN}/ops/health`,
      `${ORIGIN}/ops/me`,
    ])
  })

  it('search sends the raw term as q, unnormalized', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ key_type: 'email', hits: [], timed_out: [] }), { status: 200 }))
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    await client.search('  Daniel@Example.com ')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${ORIGIN}/ops/search?q=++Daniel%40Example.com+`)
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('reveal is the one POST, with a JSON body, to /ops/reveal', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ target_type: 'user', target_id: 'u-1', field: 'email', value: 'x' }), { status: 200 }),
    )
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    const read = await client.reveal({ target_type: 'user', target_id: 'u-1', field: 'email' })
    expect(read.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${ORIGIN}/ops/reveal`)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ target_type: 'user', target_id: 'u-1', field: 'email' }))
  })

  it('a 404 reads as unavailable — the deployment-level condition pages render as such', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'not configured' }), { status: 404 }))
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    const read = await client.overview()
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.error.kind).toBe('unavailable')
      expect(read.error.message).toMatch(/no read-only ops database/)
    }
  })

  it('a 401 drops the origin token through opsFetch and reports the read failed', async () => {
    const storage = stubStorage()
    storage.setItem(`haven.ops.token.${ORIGIN}`, 't')
    fetchMock.mockResolvedValue(new Response('', { status: 401 }))
    const client = createOpsClient(storage, ORIGIN, () => {})
    const read = await client.me()
    expect(read.ok).toBe(false)
    expect(storage.getItem(`haven.ops.token.${ORIGIN}`)).toBeNull()
  })

  it('authStart is a placeholder that routes through the session, never a fetch', async () => {
    const client = createOpsClient(stubStorage(), ORIGIN, () => {})
    expect(() => client.authStart('nonce')).toThrow(/session/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
