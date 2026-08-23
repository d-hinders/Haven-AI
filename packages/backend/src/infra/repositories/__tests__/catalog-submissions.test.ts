/**
 * Real-DB tests for the catalogue submission queue repository (#1711, epic
 * #1717) — per epic #1219's rule, every claim here is a claim about POSTGRES:
 * that "one pending/active submission per host" is a DATABASE invariant (the
 * partial unique index from migration 066, reached through INSERT ... ON
 * CONFLICT ... WHERE), not a check-then-act hope, and that the pending count
 * feeding the 429 cap tracks exactly the non-terminal rows.
 */
import { beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  countPendingCatalogSubmissions,
  findPendingCatalogSubmissionByHost,
  insertCatalogSubmission,
  INSERT_CATALOG_SUBMISSION_SQL,
} from '../catalog-submissions.js'

const TOKEN = 'ab'.repeat(24) // 48 hex chars, route-shaped

/** Cap high enough to be out of the way unless a test is about the cap. */
const NO_CAP = 10_000

function submit(hostname: string, n: number, queueCap = NO_CAP) {
  return insertCatalogSubmission({
    hostname,
    resource_url: `https://${hostname}/service/${n}`,
    submitter_ip: '127.0.0.1',
    verify_token: TOKEN,
    queueCap,
  })
}

describeDb('catalog_submissions (#1711)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
  })

  it('inserts a submitted row and reads it back by host', async () => {
    const created = await submit('mcp.example.com', 1)
    expect(created).toMatchObject({ status: 'submitted' })
    expect(created!.verify_token).toBe(TOKEN)

    const byHost = await findPendingCatalogSubmissionByHost('mcp.example.com')
    expect(byHost?.id).toBe(created!.id)
    expect(byHost!.status).toBe('submitted')
  })

  it('keeps ONE pending submission per host: a second URL on the same host is a no-op', async () => {
    const first = await submit('mcp.example.com', 1)
    const second = await submit('mcp.example.com', 99)

    expect(second).toBeNull()
    expect(await countPendingCatalogSubmissions()).toBe(1)
    const byHost = await findPendingCatalogSubmissionByHost('mcp.example.com')
    expect(byHost?.id).toBe(first!.id)
  })

  it('CONCURRENT first-time submits of one host produce exactly one row', async () => {
    // The route seizes the queue with SELECT-then-INSERT; without the partial
    // unique index two replica-facing callers would both pass the dedupe and
    // write two rows. Postgres serialises them via the index.
    const results = await Promise.all([
      submit('mcp.example.com', 1),
      submit('mcp.example.com', 2),
      submit('mcp.example.com', 3),
    ])

    const created = results.filter((r) => r !== null)
    expect(created.length).toBe(1)
    expect(await countPendingCatalogSubmissions()).toBe(1)
  })

  it('a terminal status releases the host for a fresh submission', async () => {
    const first = await submit('mcp.example.com', 1)
    expect(first).not.toBeNull()

    // SI4 lifecycle: probe/ownership failure degrades the row to a terminal
    // state. The host is then eligible to submit again.
    await db.query("UPDATE catalog_submissions SET status = 'failed', updated_at = now() WHERE id = $1", [
      first!.id,
    ])

    const second = await submit('mcp.example.com', 2)
    expect(second?.id).not.toBe(first!.id)
    expect(await countPendingCatalogSubmissions()).toBe(1)
  })

  // The claim under test is a claim about POSTGRES under concurrency, which is
  // why it cannot live in the mocked route suite. A count-then-insert pair with
  // no mutual exclusion lets every member of a concurrent burst read a count
  // below the cap before any of them commits, so all of them write and the
  // pending set overshoots. Under READ COMMITTED, folding the ceiling into the
  // INSERT's WHERE is NOT sufficient either — each statement takes a fresh
  // snapshot. Only the advisory lock makes this hold.
  it('CONCURRENT distinct-host submits cannot push the pending set past the cap', async () => {
    const CAP = 5
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => submit(`burst${i}.example.com`, i, CAP)),
    )

    expect(await countPendingCatalogSubmissions()).toBe(CAP)
  })

  it('refuses the insert at the cap and admits it one below', async () => {
    const CAP = 3
    await submit('a.example.com', 1, CAP)
    await submit('b.example.com', 2, CAP)
    // Two pending, cap 3 — this one is the last that fits.
    expect(await submit('c.example.com', 3, CAP)).not.toBeNull()
    // Now at the cap: refused, and NOT because of dedupe (fresh host).
    expect(await submit('d.example.com', 4, CAP)).toBeNull()
    expect(await countPendingCatalogSubmissions()).toBe(CAP)
    expect(await findPendingCatalogSubmissionByHost('d.example.com')).toBeNull()
  })

  // The burst test above passes with OR without the advisory lock: 20 pooled
  // transactions stagger enough that each INSERT's COUNT subquery usually sees
  // the previous commits, so the predicate alone appears to hold. That makes it
  // useless as proof. This test interleaves two transactions DELIBERATELY —
  // both inside their INSERT before either commits — which is the window
  // READ COMMITTED actually leaves open, and which only mutual exclusion closes.
  // Verified independently: two hand-interleaved sessions with the predicate and
  // no lock both insert past a cap of 1.
  it('two INTERLEAVED transactions cannot both slip past the cap', async () => {
    const CAP = 1
    const a = await db.connect()
    const b = await db.connect()
    // A pg client carries its own `connect`, which `withTransaction` would take
    // as "this can borrow a connection" and call — reusing an open client.
    // Hand it query-only executors so it runs inline on the transactions below.
    const txA = { query: (sql: string, values?: unknown[]) => a.query(sql, values) }
    const txB = { query: (sql: string, values?: unknown[]) => b.query(sql, values) }
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')

      // A takes the queue lock and writes the one row the cap allows.
      const first = await insertCatalogSubmission(
        { hostname: 'a.example.com', resource_url: 'https://a.example.com/s', submitter_ip: '127.0.0.1', verify_token: TOKEN, queueCap: CAP },
        txA,
      )
      expect(first).not.toBeNull()

      // B starts while A is still UNCOMMITTED.
      let bSettled = false
      const pendingB = insertCatalogSubmission(
        { hostname: 'b.example.com', resource_url: 'https://b.example.com/s', submitter_ip: '127.0.0.1', verify_token: TOKEN, queueCap: CAP },
        txB,
      ).then((result) => {
        bSettled = true
        return result
      })

      // The mutual exclusion asserted DIRECTLY, and this is the assertion that
      // makes the test proof rather than coincidence: while A holds the queue
      // lock, B must still be waiting. Merely committing A and checking the
      // outcome is a race — B's INSERT and A's COMMIT are in flight together,
      // and A's usually wins, which is why the earlier version of this test
      // stayed green with the lock removed.
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(bSettled).toBe(false)

      await a.query('COMMIT')
      const second = await pendingB
      await b.query('COMMIT')

      // And once it could look, A's row was there, so B is refused.
      expect(second).toBeNull()
    } finally {
      a.release()
      b.release()
    }

    expect(await countPendingCatalogSubmissions()).toBe(CAP)
  })

  // #1712 derives its token-expiry deadline from this column, so a submitter
  // who could set or freeze it could hold a token alive past its TTL and make
  // that expiry check decorative.
  it('created_at is server-generated and cannot be supplied by the caller', async () => {
    // Bracket with the DATABASE's clock, not Node's. The two can be seconds
    // apart (they were, against a containerised Postgres), and a test that
    // compares one clock to the other measures the skew, not the guarantee.
    const before = await db.query<{ t: Date }>('SELECT now() AS t')
    const created = await submit('mcp.example.com', 1)
    const after = await db.query<{ t: Date }>('SELECT now() AS t')

    const { rows } = await db.query<{ created_at: Date }>(
      'SELECT created_at FROM catalog_submissions WHERE id = $1',
      [created!.id],
    )
    const createdAt = new Date(rows[0].created_at).getTime()
    expect(createdAt).toBeGreaterThanOrEqual(new Date(before.rows[0].t).getTime())
    expect(createdAt).toBeLessThanOrEqual(new Date(after.rows[0].t).getTime())

    // The write names its columns explicitly and created_at is not among them,
    // so there is no parameter for a caller's value to travel through.
    expect(INSERT_CATALOG_SUBMISSION_SQL).not.toMatch(/created_at/)
  })

  // The other half of the same guarantee: a token's issued-at must not be
  // inherited. This slice never reissues onto an existing row — a resubmission
  // while pending is a NO-OP returning the original untouched (so the original
  // deadline stands), and a host only becomes submittable again after a
  // terminal status, which produces a genuinely NEW row with a NEW timestamp.
  it('a post-terminal resubmission gets a NEW row with a strictly later created_at', async () => {
    const first = await submit('mcp.example.com', 1)
    const firstRow = await db.query<{ created_at: Date }>(
      'SELECT created_at FROM catalog_submissions WHERE id = $1',
      [first!.id],
    )
    await db.query("UPDATE catalog_submissions SET status = 'failed' WHERE id = $1", [first!.id])

    // Postgres timestamps are microsecond-resolution; make the ordering
    // unambiguous rather than relying on the two inserts landing apart.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const second = await submit('mcp.example.com', 2)
    expect(second!.id).not.toBe(first!.id)
    const secondRow = await db.query<{ created_at: Date }>(
      'SELECT created_at FROM catalog_submissions WHERE id = $1',
      [second!.id],
    )

    expect(new Date(secondRow.rows[0].created_at).getTime()).toBeGreaterThan(
      new Date(firstRow.rows[0].created_at).getTime(),
    )
  })

  it('the pending count for the 429 cap counts only non-terminal rows', async () => {
    await submit('a.example.com', 1)
    await submit('b.example.com', 2)
    const failed = await submit('c.example.com', 3)
    await db.query("UPDATE catalog_submissions SET status = 'failed' WHERE id = $1", [failed!.id])

    expect(await countPendingCatalogSubmissions()).toBe(2)
  })
})
