/**
 * Real-Postgres proof for the `catalogIngest` leader lock (#1713, epic #1717).
 *
 * These cannot be mocked, for the reason epic #1219's rule exists: every
 * claim here is a claim about POSTGRES — that two SESSIONS actually exclude
 * each other on this key, that the key does not collide with the neighbouring
 * monitors, and that leadership is released rather than leaked. A fake pool
 * would assert only that the code sent the strings the test already expected,
 * which is exactly how a lock that does not lock passes its own suite.
 *
 * The precedent this file is written against: #1711's queue cap was a
 * non-atomic count-then-insert, and reasoning about the SQL said it was a cap.
 * Two real interleaved sessions said otherwise. So the central test below
 * INTERLEAVES — the second acquisition is attempted while the first is
 * demonstrably still held, not before it starts and not after it finishes.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import pool from '../../db.js'
import { describeDb, initDbHarness } from '../../infra/__tests__/helpers/db-harness.js'
import { LEADER_LOCK_KEYS, runIfLeader, type PoolLike } from '../leader-lock.js'

const asPool = pool as unknown as PoolLike
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every lock id in the single-argument keyspace, for the collision checks. */
const ALL_KEYS = Object.entries(LEADER_LOCK_KEYS)

describeDb('catalogIngest leader lock (#1713)', () => {
  // In a HOOK, not in the test bodies (#2329). This file's FIRST
  // `initDbHarness()` pays the full migration run and, in CI, the wait for
  // whichever vitest worker holds the migration advisory lock — the cost
  // `vitest.config.ts`'s `hookTimeout: 120_000` exists to budget (#1372).
  // Inside an `it` body it was charged to vitest's 5000 ms `testTimeout`
  // instead, and two of these cases timed out on an unrelated pull request
  // (#2295's run) with a bare "Test timed out in 5000ms" that named the lock
  // test rather than the harness. Init is idempotent and memoised, so hoisting
  // it costs the tests below one resolved-promise await.
  beforeAll(async () => {
    await initDbHarness()
  })

  it('every leader-lock key is distinct — a duplicate would silently merge two monitors', () => {
    // #1711 shipped a fix because its lock duplicated `accountDeploy`'s. This
    // is the cheap structural version of that lesson, and it fails loudly the
    // moment someone copies a line and forgets to change the number.
    const values = ALL_KEYS.map(([, value]) => value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('does not reuse 811003, the retired schedule-renewal monitor (#834)', () => {
    // The block's rule is never to REUSE a value, not merely to avoid live
    // ones — a recycled id collides with anything still holding the old lease.
    expect(Object.values(LEADER_LOCK_KEYS)).not.toContain(811003)
    expect(LEADER_LOCK_KEYS.catalogIngest).toBe(811008)
  })

  it('INTERLEAVED: a second session cannot enter while the first holds catalogIngest', async () => {
    // The proof, done the way #1711's cap should have been done from the
    // start. `enteredFirst` resolves only once tick A is INSIDE its critical
    // section, and A stays inside until `releaseFirst` is called — so B's
    // attempt provably overlaps A's hold rather than merely following it.

    let releaseFirst: () => void = () => {}
    const firstHolding = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let enteredFirst: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })

    let concurrent = 0
    let peakConcurrent = 0

    const first = runIfLeader(
      LEADER_LOCK_KEYS.catalogIngest,
      async () => {
        concurrent += 1
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        enteredFirst()
        await firstHolding
        concurrent -= 1
      },
      asPool,
    )

    await firstEntered

    // A is inside, on its own connection. B asks now.
    let secondRan = false
    const second = await runIfLeader(
      LEADER_LOCK_KEYS.catalogIngest,
      async () => {
        concurrent += 1
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        secondRan = true
        concurrent -= 1
      },
      asPool,
    )

    expect(second).toBe(false)
    expect(secondRan).toBe(false)
    expect(peakConcurrent).toBe(1)

    releaseFirst()
    expect(await first).toBe(true)
  })

  it('MUTATION-SENSITIVE: the same interleave on a DIFFERENT key lets both in', async () => {
    // The control. If the test above ever passes because `runIfLeader` refuses
    // everything rather than because the lock excludes, this one fails too —
    // which is what tells the two apart.

    let releaseFirst: () => void = () => {}
    const firstHolding = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let enteredFirst: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })

    const first = runIfLeader(
      LEADER_LOCK_KEYS.catalogIngest,
      async () => {
        enteredFirst()
        await firstHolding
      },
      asPool,
    )
    await firstEntered

    // catalogRefresh must be unaffected — "existing monitor behavior unchanged
    // for catalogRefresh" is an explicit acceptance criterion of #1713.
    let refreshRan = false
    const refresh = await runIfLeader(
      LEADER_LOCK_KEYS.catalogRefresh,
      async () => {
        refreshRan = true
      },
      asPool,
    )

    expect(refresh).toBe(true)
    expect(refreshRan).toBe(true)

    releaseFirst()
    await first
  })

  it('releases leadership, so the very next tick can win it again', async () => {
    expect(await runIfLeader(LEADER_LOCK_KEYS.catalogIngest, async () => {}, asPool)).toBe(true)
    expect(await runIfLeader(LEADER_LOCK_KEYS.catalogIngest, async () => {}, asPool)).toBe(true)

    // And nothing is left held on the database itself.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS held
         FROM pg_locks
        WHERE locktype = 'advisory' AND objid = $1 AND granted`,
      [LEADER_LOCK_KEYS.catalogIngest],
    )
    expect(rows[0].held).toBe(0)
  })

  it('a tick that throws still frees the lock for the next replica', async () => {
    await expect(
      runIfLeader(
        LEADER_LOCK_KEYS.catalogIngest,
        async () => {
          throw new Error('probe batch blew up')
        },
        asPool,
      ),
    ).rejects.toThrow('probe batch blew up')

    // Leadership must not be stranded by a failed batch — otherwise one bad
    // probe run stops catalogue ingestion cluster-wide until a redeploy.
    await sleep(10)
    expect(await runIfLeader(LEADER_LOCK_KEYS.catalogIngest, async () => {}, asPool)).toBe(true)
  })
})
