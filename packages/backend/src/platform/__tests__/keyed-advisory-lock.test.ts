/**
 * Real-Postgres tests for the keyed advisory lock (#1673).
 *
 * These cannot be mocked, for the same reason #1219's rule exists: every
 * claim here is a claim about POSTGRES — that two SESSIONS actually exclude
 * each other, that a waiter blocks rather than skipping, and that
 * `lock_timeout` bounds that wait. A fake pool would only assert that the
 * code sent the strings the test already expected, which is precisely how a
 * lock that does not lock passes its own suite.
 *
 * The mocked half — fail-open when the pool is unreachable — lives beside
 * these because it cannot be reached with a working database.
 */
import { describe, expect, it, vi } from 'vitest'
import pool from '../../db.js'
import { describeDb } from '../../infra/__tests__/helpers/db-harness.js'
import {
  KEYED_LOCK_NAMESPACES,
  advisoryLockIdFor,
  withKeyedAdvisoryLock,
  type PoolLike,
} from '../leader-lock.js'

const NS = KEYED_LOCK_NAMESPACES.accountDeploy
const asPool = pool as unknown as PoolLike

let subjectCounter = 0
const freshSubject = () => `84532:0xtest${Date.now()}${subjectCounter++}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describeDb('withKeyedAdvisoryLock (#1673)', () => {
  it('MUTATION PROOF: concurrent holders of the same subject do NOT overlap', async () => {
    // The property the whole issue is about. Two callers on the same subject
    // must run one after the other; if the lock is dropped or the namespace
    // ignored, both enter the critical section and `maxConcurrent` reaches 2.
    const subject = freshSubject()
    let concurrent = 0
    let maxConcurrent = 0
    const order: string[] = []

    const critical = (name: string) => async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(`${name}:enter`)
      await sleep(120)
      order.push(`${name}:exit`)
      concurrent -= 1
    }

    await Promise.all([
      withKeyedAdvisoryLock(NS, subject, critical('a'), { db: asPool }),
      withKeyedAdvisoryLock(NS, subject, critical('b'), { db: asPool }),
    ])

    expect(maxConcurrent).toBe(1)
    // Whoever won, the other's enter comes after the winner's exit.
    expect(order[1]).toMatch(/:exit$/)
  })

  it('the waiter observes what the winner DID — the double-check this exists for', async () => {
    // A monitor tick that loses should skip; this caller must wait and then
    // see the result. Modelled with shared state the winner sets.
    const subject = freshSubject()
    let deployed = false
    let deploys = 0

    const deployOnce = async () => {
      if (deployed) return 'already'
      await sleep(80)
      deployed = true
      deploys += 1
      return 'deployed'
    }

    const [first, second] = await Promise.all([
      withKeyedAdvisoryLock(NS, subject, deployOnce, { db: asPool }),
      withKeyedAdvisoryLock(NS, subject, deployOnce, { db: asPool }),
    ])

    expect(deploys).toBe(1)
    expect([first, second].sort()).toEqual(['already', 'deployed'])
  })

  it('DIFFERENT subjects never wait on each other', async () => {
    let maxConcurrent = 0
    let concurrent = 0
    const critical = async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(80)
      concurrent -= 1
    }

    await Promise.all([
      withKeyedAdvisoryLock(NS, freshSubject(), critical, { db: asPool }),
      withKeyedAdvisoryLock(NS, freshSubject(), critical, { db: asPool }),
    ])

    // Two accounts deploying at once is the normal case and must not serialise.
    expect(maxConcurrent).toBe(2)
  })

  it('the lock is released — a later caller is not blocked by a finished one', async () => {
    const subject = freshSubject()
    await withKeyedAdvisoryLock(NS, subject, async () => {}, { db: asPool })

    const started = Date.now()
    await withKeyedAdvisoryLock(NS, subject, async () => {}, { db: asPool, waitMs: 2_000 })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a THROWING body still releases the lock', async () => {
    const subject = freshSubject()
    await expect(
      withKeyedAdvisoryLock(NS, subject, async () => { throw new Error('boom') }, { db: asPool }),
    ).rejects.toThrow('boom')

    // If the finally did not unlock, this would hang until the timeout.
    const started = Date.now()
    await withKeyedAdvisoryLock(NS, subject, async () => {}, { db: asPool, waitMs: 2_000 })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('MUTATION PROOF: past the wait bound it runs ANYWAY, unserialised — fail-open, not refuse', async () => {
    // This lock stops duplicated work; it does not make the work safe. So a
    // caller that cannot acquire in time must still do the work — degrading
    // to the pre-#1673 behaviour — rather than fail the request. Remove the
    // fail-open and the second call rejects instead of running.
    const subject = freshSubject()
    const degraded: string[] = []
    let holderDone: () => void = () => {}
    const holderReleased = new Promise<void>((resolve) => { holderDone = resolve })

    const holder = withKeyedAdvisoryLock(NS, subject, async () => { await holderReleased }, { db: asPool })
    await sleep(100)

    let ranAnyway = false
    await withKeyedAdvisoryLock(NS, subject, async () => { ranAnyway = true }, {
      db: asPool,
      waitMs: 150,
      onDegraded: (reason) => degraded.push(reason),
    })

    expect(ranAnyway).toBe(true)
    expect(degraded).toEqual(['timeout'])

    holderDone()
    await holder
  })

  it('an unreachable pool degrades instead of throwing', async () => {
    const broken: PoolLike = { connect: async () => { throw new Error('pool exhausted') } }
    const degraded: string[] = []
    let ran = false

    await withKeyedAdvisoryLock(NS, freshSubject(), async () => { ran = true }, {
      db: broken,
      onDegraded: (reason) => degraded.push(reason),
    })

    expect(ran).toBe(true)
    expect(degraded).toEqual(['error'])
  })

  it('the connection goes back to the pool with lock_timeout reset, not leaked', async () => {
    // A session setting that survived into the pool would silently apply this
    // timeout to unrelated queries on the next borrower.
    const release = vi.fn()
    const statements: string[] = []
    const instrumented: PoolLike = {
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql)
          return { rows: [] }
        },
        release,
      }),
    }

    await withKeyedAdvisoryLock(NS, 'subject', async () => {}, { db: instrumented })

    expect(statements.some((s) => /RESET lock_timeout/.test(s))).toBe(true)
    // Released back to the pool, not destroyed: nothing went wrong.
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('the subject id is stable, and namespaced away from the monitor keyspace', () => {
    expect(advisoryLockIdFor('84532:0xabc')).toBe(advisoryLockIdFor('84532:0xabc'))
    expect(advisoryLockIdFor('84532:0xabc')).not.toBe(advisoryLockIdFor('8453:0xabc'))
    // int4 range — Postgres would reject anything wider.
    const id = advisoryLockIdFor('anything')
    expect(id).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(id).toBeLessThan(2 ** 31)
  })
})
