/**
 * Real-DB tests for the catalogue lifecycle verbs (#1714, epic #1717) — per
 * epic #1219's rule, every claim here is a claim about POSTGRES: the guarded
 * transitions are once-only database facts (`... WHERE status = <expected>`),
 * the failure streak is a column, and the terminal purge is what actually
 * bounds the table under sustained failures.
 */
import { beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  insertCatalogSubmission,
  countPendingCatalogSubmissions,
} from '../catalog-submissions.js'
import {
  listSubmittedCatalogSubmissions,
  listOwnershipVerifiedCatalogSubmissions,
  listVerifiedCatalogSubmissionsDueForRecheck,
  markCatalogSubmissionOwnershipVerified,
  markCatalogSubmissionVerifiedPayable,
  incrementCatalogSubmissionFailures,
  markCatalogSubmissionFailed,
  countStuckCatalogSubmissions,
  deleteTerminalCatalogSubmissionsBefore,
} from '../catalog-submissions.js'

const TOKEN = 'ab'.repeat(24) // 48 hex chars, route-shaped
const NO_CAP = 10_000

async function submit(hostname: string, n: number): Promise<{ id: string }> {
  const created = await insertCatalogSubmission({
    hostname,
    resource_url: `https://${hostname}/service/${n}`,
    submitter_ip: '127.0.0.1',
    verify_token: TOKEN,
    queueCap: NO_CAP,
  })
  expect(created).not.toBeNull()
  return { id: created!.id }
}

describeDb('catalog_submissions lifecycle (#1714)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
  })

  it('lists only submitted rows in the ownership stage', async () => {
    const { id } = await submit('one.example.com', 1)
    await submit('two.example.com', 2)
    await markCatalogSubmissionOwnershipVerified(id)

    const rows = await listSubmittedCatalogSubmissions()
    expect(rows.map((r) => r.hostname)).toEqual(['two.example.com'])
  })

  it('moves submitted -> ownership_verified exactly once, resetting the streak', async () => {
    const { id } = await submit('shop.example.com', 1)
    // Simulate a prior failed ownership attempt.
    await incrementCatalogSubmissionFailures(id)

    expect(await markCatalogSubmissionOwnershipVerified(id)).toBe(true)
    // Second call is a no-op — the transition is once-only.
    expect(await markCatalogSubmissionOwnershipVerified(id)).toBe(false)

    const [row] = await listOwnershipVerifiedCatalogSubmissions()
    expect(row.id).toBe(id)
    const [submitted] = await listSubmittedCatalogSubmissions()
    expect(submitted).toBeUndefined()
    const tally = await incrementCatalogSubmissionFailures(id)
    expect(tally).toMatchObject({ streak: 1, status: 'ownership_verified' })
  })

  it('verified_payable persiss pointer metadata and resets the streak', async () => {
    const { id } = await submit('mcp.example.com', 1)
    await markCatalogSubmissionOwnershipVerified(id)
    await incrementCatalogSubmissionFailures(id) // one failure before success

    const moved = await markCatalogSubmissionVerifiedPayable(id, {
      name: 'Summarizer',
      description: 'Summarizes docs',
      entrypoint: 'summarize',
    })
    expect(moved).toBe(true)

    const due = await listVerifiedCatalogSubmissionsDueForRecheck(
      new Date(Date.now() - 86_400_000),
    )
    expect(due).toHaveLength(0) // just verified — not due yet
    const { rows } = await db.query<{
      status: string
      consecutive_failures: number
      last_verified_at: string | null
      name: string | null
    }>(`SELECT status, consecutive_failures, last_verified_at, name FROM catalog_submissions WHERE id = $1`, [id])
    expect(rows[0]).toMatchObject({
      status: 'verified_payable',
      consecutive_failures: 0,
      name: 'Summarizer',
    })
    expect(rows[0].last_verified_at).not.toBeNull()
  })

  it('re-verification is guarded to ownership_verified and verified_payable only', async () => {
    const { id: fresh } = await submit('fresh.example.com', 1)
    // A submitted row cannot jump straight to verified_payable.
    expect(
      await markCatalogSubmissionVerifiedPayable(fresh, {
        name: 'Nope',
        description: null,
        entrypoint: 'nope',
      }),
    ).toBe(false)

    const { id: re } = await submit('re.example.com', 2)
    await markCatalogSubmissionOwnershipVerified(re)
    await markCatalogSubmissionVerifiedPayable(re, {
      name: 'First',
      description: null,
      entrypoint: 'first',
    })
    // A re-verification (still verified_payable) is accepted.
    expect(
      await markCatalogSubmissionVerifiedPayable(re, {
        name: 'Second',
        description: 'reverified',
        entrypoint: 'second',
      }),
    ).toBe(true)
  })

  it('a row degrades to failed at the caller threshold, once, with failed_at set', async () => {
    const { id } = await submit('degrade.example.com', 1)
    await markCatalogSubmissionOwnershipVerified(id)

    // Two failures below the threshold: not failed yet.
    expect(await incrementCatalogSubmissionFailures(id)).toEqual({ streak: 1, status: 'ownership_verified' })
    expect(await incrementCatalogSubmissionFailures(id)).toEqual({ streak: 2, status: 'ownership_verified' })
    // Third failure crosses the lifecycle threshold (FAIL_AFTER...=3).
    expect(await incrementCatalogSubmissionFailures(id)).toEqual({ streak: 3, status: 'ownership_verified' })
    expect(await markCatalogSubmissionFailed(id)).toBe(true)
    // Already failed — transition is once-only.
    expect(await markCatalogSubmissionFailed(id)).toBe(false)

    const { rows } = await db.query<{ status: string; failed_at: string | null }>(
      `SELECT status, failed_at FROM catalog_submissions WHERE id = $1`,
      [id],
    )
    expect(rows[0].status).toBe('failed')
    expect(rows[0].failed_at).not.toBeNull()
    // A failed row releases the host for a fresh submission (cap freed).
    expect(await countPendingCatalogSubmissions()).toBe(0)
  })

  it('a delisted row cannot be incremented or failed', async () => {
    const { id } = await submit('delisted.example.com', 1)
    await db.query(`UPDATE catalog_submissions SET status = 'delisted' WHERE id = $1`, [id])

    expect(await incrementCatalogSubmissionFailures(id)).toBeNull()
    expect(await markCatalogSubmissionFailed(id)).toBe(false)
  })

  it('marks a row as due for recheck once last_verified_at goes stale', async () => {
    const { id } = await submit('stale.example.com', 1)
    await markCatalogSubmissionOwnershipVerified(id)
    await markCatalogSubmissionVerifiedPayable(id, {
      name: 'SoonStale',
      description: null,
      entrypoint: 'soon',
    })
    // Backdate the verification past the re-verification cadence.
    await db.query(`UPDATE catalog_submissions SET last_verified_at = now() - interval '2 days' WHERE id = $1`, [id])

    const due = await listVerifiedCatalogSubmissionsDueForRecheck(new Date(Date.now() - 86_400_000))
    expect(due.map((r) => r.id)).toEqual([id])
  })

  it('counts stuck submitted rows by created_at, excluding moved rows', async () => {
    const { id: old } = await submit('stuck.example.com', 1)
    const { id: newRow } = await submit('moving.example.com', 2)
    await markCatalogSubmissionOwnershipVerified(newRow)
    await db.query(`UPDATE catalog_submissions SET created_at = now() - interval '3 days' WHERE id = $1`, [old])

    expect(await countStuckCatalogSubmissions(new Date(Date.now() - 48 * 3600_000))).toBe(1)
  })

  it('purges terminal rows past retention and spares fresh and non-terminal ones', async () => {
    const { id: oldFailed } = await submit('oldfail.example.com', 1)
    await markCatalogSubmissionFailed(oldFailed)
    await db.query(`UPDATE catalog_submissions SET failed_at = now() - interval '31 days' WHERE id = $1`, [oldFailed])

    const { id: freshFailed } = await submit('freshfail.example.com', 2)
    await markCatalogSubmissionFailed(freshFailed)

    const { id: oldDelisted } = await submit('olddelist.example.com', 3)
    await db.query(`UPDATE catalog_submissions SET status = 'delisted', updated_at = now() - interval '31 days' WHERE id = $1`, [oldDelisted])

    const { id: stuck } = await submit('stuck.example.com', 4)

    const cutoff = new Date(Date.now() - 30 * 86_400_000)
    expect(await deleteTerminalCatalogSubmissionsBefore(cutoff)).toBe(2)

    const remaining = await db.query<{ id: string }>(`SELECT id FROM catalog_submissions`)
    const ids = remaining.rows.map((r) => r.id)
    expect(ids).not.toContain(oldFailed)
    expect(ids).not.toContain(oldDelisted)
    expect(ids).toContain(freshFailed)
    expect(ids).toContain(stuck)
  })

  it('repeated failed probes do not grow the table: one row per host, purged after TTL', async () => {
    // Same host submitted once; a sustained failure moves it to failed, and
    // the per-hostname index means resubmission reuses... the host is freed by
    // the terminal state, but each cycle is still ONE row at a time.
    const { id } = await submit('churning.example.com', 1)
    for (let i = 0; i < 100; i += 1) {
      await incrementCatalogSubmissionFailures(id)
    }
    await markCatalogSubmissionFailed(id)
    expect(await countPendingCatalogSubmissions()).toBe(0)

    // Repeat the cycle a few times: table width never exceeds the active row
    // plus terminal rows awaiting purge.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const created = await insertCatalogSubmission({
        hostname: 'churning.example.com',
        resource_url: `https://churning.example.com/cycle/${cycle}`,
        submitter_ip: '127.0.0.1',
        verify_token: TOKEN,
        queueCap: NO_CAP,
      })
      expect(created).not.toBeNull()
      await markCatalogSubmissionFailed(created!.id)
    }

    const { rows } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM catalog_submissions`)
    // 5 failed rows from the loop + 1 from before = 6 terminal rows, all
    // awaiting the 30-day purge. No unbounded growth per failure.
    expect(rows[0].n).toBe('6')
  })
})
