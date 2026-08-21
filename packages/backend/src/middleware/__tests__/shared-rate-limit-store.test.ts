/**
 * The store's DEGRADED paths (#1680). What Postgres does is proven on the real
 * harness in `infra/repositories/__tests__/rate-limit-counters.test.ts`; what
 * is proven here is everything the store does when Postgres cannot answer, or
 * when it should not be asked at all — the parts that decide whether a
 * database hiccup becomes an outage on the front door.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SharedRateLimitStore,
  setRateLimitDegradedReporter,
} from '../shared-rate-limit-store.js'

const WINDOW = 60_000

/** Promise-returning wrapper, because the plugin's store API is callback-based. */
function incr(
  store: SharedRateLimitStore,
  key: string,
  max = 10,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(key, (err, result) => (err ? reject(err) : resolve(result!)), WINDOW, max)
  })
}

function read(store: SharedRateLimitStore, key: string): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.read(key, (err, result) => (err ? reject(err) : resolve(result!)), WINDOW)
  })
}

/** A stub Executor returning whatever the upsert would have returned. */
function dbReturning(rows: Array<{ count: number; ttl_ms: string }>) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) }
}

afterEach(() => {
  setRateLimitDegradedReporter(() => {})
  vi.restoreAllMocks()
})

describe('SharedRateLimitStore (#1680)', () => {
  it('returns the SHARED count, not a local one — the whole point', async () => {
    // A replica that has served one request still reports the cluster-wide 7.
    const db = dbReturning([{ count: 7, ttl_ms: '42000' }])
    const store = new SharedRateLimitStore({ db: db as never })

    expect(await incr(store, 'ip:1')).toEqual({ current: 7, ttl: 42000 })
  })

  it('MUTATION PROOF: a database ERROR degrades to local counting, never to a refusal', async () => {
    // Fail-closed here would lock every user out of signup and login over a
    // database hiccup. The count must keep rising locally so the limit still
    // does something, but it must never throw and never report "over".
    const db = { query: vi.fn(async () => { throw new Error('connection terminated') }) }
    const store = new SharedRateLimitStore({ db: db as never })

    expect(await incr(store, 'ip:1')).toEqual({ current: 1, ttl: WINDOW })
    expect((await incr(store, 'ip:1')).current).toBe(2)
    expect((await incr(store, 'ip:2')).current).toBe(1)
  })

  it('a SLOW query degrades on the deadline rather than hanging the request', async () => {
    // The failure the fail-open catch does NOT cover: a query that never
    // settles. Nothing else would stop it — the pool sets no statement_timeout
    // and Fastify no request timeout.
    const db = { query: vi.fn(() => new Promise(() => {})) }
    const store = new SharedRateLimitStore({ db: db as never, deadlineMs: 20 })

    const started = Date.now()
    expect(await incr(store, 'ip:1')).toEqual({ current: 1, ttl: WINDOW })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('every degradation is REPORTED — falling back must never be quiet', async () => {
    const reasons: string[] = []
    setRateLimitDegradedReporter((reason) => reasons.push(reason))

    const erroring = new SharedRateLimitStore({
      db: { query: vi.fn(async () => { throw new Error('nope') }) } as never,
    })
    await incr(erroring, 'ip:1')

    const stalling = new SharedRateLimitStore({
      db: { query: vi.fn(() => new Promise(() => {})) } as never,
      deadlineMs: 20,
    })
    await incr(stalling, 'ip:2')

    expect(reasons).toEqual(['error', 'deadline'])
  })

  it('MUTATION PROOF: a blocked key is answered from memory, without a database write', async () => {
    // The amplification guard. This table is written by UNAUTHENTICATED
    // traffic; without this, a flood costs one row-locked upsert per request.
    // Remove the short-circuit and the query count below rises with the flood.
    const db = dbReturning([{ count: 11, ttl_ms: '30000' }])
    const store = new SharedRateLimitStore({ db: db as never })

    const first = await incr(store, 'ip:flood', 10)
    expect(first.current).toBe(11)
    expect(db.query).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 50; i++) {
      const answer = await incr(store, 'ip:flood', 10)
      expect(answer.current).toBeGreaterThan(10)
    }
    // Still ONE — the other fifty were served from memory.
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('a key UNDER its limit is never short-circuited', async () => {
    const db = dbReturning([{ count: 3, ttl_ms: '30000' }])
    const store = new SharedRateLimitStore({ db: db as never })

    await incr(store, 'ip:ok', 10)
    await incr(store, 'ip:ok', 10)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('the block expires with its window — a client is not banned past it', async () => {
    const db = dbReturning([{ count: 11, ttl_ms: '20' }])
    const store = new SharedRateLimitStore({ db: db as never })

    await incr(store, 'ip:brief', 10)
    expect(db.query).toHaveBeenCalledTimes(1)

    await new Promise((resolve) => setTimeout(resolve, 40))

    // Window over: the store must ask again rather than keep refusing.
    await incr(store, 'ip:brief', 10)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('read peeks, degrades the same way, and never counts', async () => {
    const shared = dbReturning([{ count: 4, ttl_ms: '15000' }])
    expect(await read(new SharedRateLimitStore({ db: shared as never }), 'ip:1'))
      .toEqual({ current: 4, ttl: 15000 })

    const broken = new SharedRateLimitStore({
      db: { query: vi.fn(async () => { throw new Error('nope') }) } as never,
    })
    // Nothing counted locally yet, so the degraded peek is a clean slate.
    expect(await read(broken, 'ip:1')).toEqual({ current: 0, ttl: 0 })
  })

  it('child() carries the route ceiling — children are what the plugin actually uses', async () => {
    // The plugin builds one child per route from that route's config. If the
    // ceiling were lost, the blocked-key shortcut would never engage.
    const db = dbReturning([{ count: 11, ttl_ms: '30000' }])
    const parent = new SharedRateLimitStore({ db: db as never })
    const child = parent.child({ timeWindow: WINDOW, max: 10 })

    // No max passed at call time: it must come from the child's own config.
    await new Promise<void>((resolve) => child.incr('ip:child', () => resolve()))
    await new Promise<void>((resolve) => child.incr('ip:child', () => resolve()))

    expect(db.query).toHaveBeenCalledTimes(1)
  })
})
