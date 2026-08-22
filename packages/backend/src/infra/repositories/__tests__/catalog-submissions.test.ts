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
} from '../catalog-submissions.js'

const TOKEN = 'ab'.repeat(24) // 48 hex chars, route-shaped

function submit(hostname: string, n: number) {
  return insertCatalogSubmission({
    hostname,
    resource_url: `https://${hostname}/service/${n}`,
    submitter_ip: '127.0.0.1',
    verify_token: TOKEN,
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

  it('the pending count for the 429 cap counts only non-terminal rows', async () => {
    await submit('a.example.com', 1)
    await submit('b.example.com', 2)
    const failed = await submit('c.example.com', 3)
    await db.query("UPDATE catalog_submissions SET status = 'failed' WHERE id = $1", [failed!.id])

    expect(await countPendingCatalogSubmissions()).toBe(2)
  })
})
