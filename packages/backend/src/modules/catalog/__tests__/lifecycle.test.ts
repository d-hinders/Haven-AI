/**
 * Catalogue ingestion lifecycle tests (#1714, epic #1717).
 *
 * The tick is tested against a REAL migrated Postgres (epic #1219) with only
 * the network stubbed — the ownership fetcher and the JSON-RPC probe are
 * injected, exactly as in the ownership/probe slice tests. That keeps the
 * DB claims (guarded transitions, streaks, retention) real while the hostile
 * half of the world (the merchant endpoint) stays fake.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { insertCatalogSubmission, listSubmittedCatalogSubmissions } from '../../../infra/repositories/catalog-submissions.js'
import type { SafeFetchResult } from '../../../infra/http/ssrf-guard.js'
import {
  FAIL_AFTER_CONSECUTIVE_FAILURES,
  REVERIFY_CADENCE_MS,
  HostCooldown,
  expectedProofPayload,
  type OwnershipClaim,
} from '../index.js'
import {
  catalogAlerts,
  resetCatalogAlertStateForTests,
  runCatalogIngestTick,
  type CatalogIngestDeps,
} from '../lifecycle.js'

const SECRET = 'test-ownership-secret-not-a-real-key'
const TOKEN = 'ab'.repeat(24)

async function seed(hostname: string, resourceUrl?: string): Promise<OwnershipClaim> {
  const created = await insertCatalogSubmission({
    hostname,
    resource_url: resourceUrl ?? `https://${hostname}/mcp`,
    submitter_ip: '127.0.0.1',
    verify_token: TOKEN,
    queueCap: 10_000,
  })
  expect(created).not.toBeNull()
  const found = (await listSubmittedCatalogSubmissions()).find((r) => r.id === created!.id)
  expect(found).toBeDefined()
  return {
    submissionId: found!.id,
    hostname,
    verifyToken: TOKEN,
    tokenIssuedAt: new Date(found!.created_at),
  }
}

/** A well-known server that serves exactly one claim's proof and 404s the rest. */
function wellKnownServer(claim: OwnershipClaim, secret: string): (url: string) => Promise<SafeFetchResult> {
  const proof = expectedProofPayload(claim, secret)
  return async (url) =>
    url.startsWith(`https://${claim.hostname}/.well-known/haven-verify-`)
      ? { ok: true, status: 200, body: proof, headers: {}, finalUrl: url }
      : { ok: false, reason: 'http_status', detail: 'HTTP 404' }
}

const inertServer: (url: string) => Promise<SafeFetchResult> = async () => ({
  ok: false,
  reason: 'http_status',
  detail: 'HTTP 404',
})

type McpLeg = { jsonrpc: string; id: number; method: string }

/** A payable MCP server: initialize -> tools/list -> unpaid tools/call answers 402. */
function mcpServer(metadata?: { name?: string; description?: string }): (url: string, payload: unknown) => Promise<SafeFetchResult> {
  const m = { name: 'Summarizer', description: 'Summarizes documents', entrypoint: 'summarize', ...metadata }
  return async (_url: string, payload: unknown) => {
    const leg = payload as McpLeg
    if (leg.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: leg.id, result: { protocolVersion: '2025-06-18' } }),
        headers: {},
        finalUrl: _url,
      }
    }
    if (leg.method === 'tools/list') {
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: leg.id, result: { tools: [{ name: m.name }] } }),
        headers: {},
        finalUrl: _url,
      }
    }
    return {
      ok: true,
      status: 402,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: leg.id,
        error: {
          code: -32000,
          message: 'Payment Required',
          data: {
            payment_required: {
              accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000' }],
              extensions: {
                bazaar: {
                  schema: { name: m.name, description: m.description, entrypoint: m.entrypoint },
                },
              },
            },
          },
        },
      }),
      headers: {},
      finalUrl: _url,
    }
  }
}

/** A non-payable endpoint: tools/call answers 200 with no payment_required. */
const brokenMcp = (): (url: string, payload: unknown) => Promise<SafeFetchResult> =>
  mcpServerImplWithToolsCall(200, {})

function mcpServerImplWithToolsCall(status: number, body: unknown): (url: string, payload: unknown) => Promise<SafeFetchResult> {
  return async (_url: string, payload: unknown) => {
    const leg = payload as McpLeg
    if (leg.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: leg.id, result: { protocolVersion: '2025-06-18' } }),
        headers: {},
        finalUrl: _url,
      }
    }
    if (leg.method === 'tools/list') {
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: leg.id, result: { tools: [{ name: 'do' }] } }),
        headers: {},
        finalUrl: _url,
      }
    }
    return { ok: true, status, body: JSON.stringify(body), headers: {}, finalUrl: _url }
  }
}

async function row(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(`SELECT * FROM catalog_submissions WHERE id = $1`, [id])
  return rows[0] as Record<string, unknown>
}

function tickDeps(overrides: Partial<CatalogIngestDeps> = {}): CatalogIngestDeps {
  return {
    verifySecret: SECRET,
    resolveTxt: async () => [],
    ...overrides,
  }
}

describeDb('catalog ingestion lifecycle (#1714)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
    resetCatalogAlertStateForTests()
  })

  it('walks a submission to verified_payable in one tick', async () => {
    const claim = await seed('shop.example.com')
    const report = await runCatalogIngestTick(
      tickDeps({ fetchText: wellKnownServer(claim, SECRET), post: mcpServer() }),
    )

    expect(report.ownershipVerified).toBe(1)
    expect(report.probedVerified).toBe(1)
    expect(report.acted).toBe(true)

    const saved = await row(claim.submissionId)
    expect(saved.status).toBe('verified_payable')
    expect(saved.name).toBe('Summarizer')
    expect(saved.description).toBe('Summarizes documents')
    expect((saved as { last_verified_at: string | null }).last_verified_at).not.toBeNull()
  })

  it('leaves a submitted row pending through transient ownership failure, then fails it on token expiry', async () => {
    const claim = await seed('slow.example.com')
    const fetchText = inertServer
    const post = vi.fn()
    const now = new Date()

    // First tick: proof not there yet. Row stays submitted, nothing probed.
    let report = await runCatalogIngestTick(tickDeps({ fetchText, post, now: () => now }))
    expect(report.ownershipVerified).toBe(0)
    expect(post).not.toHaveBeenCalled()
    expect((await row(claim.submissionId)).status).toBe('submitted')

    // Later ticks keep retrying until the token expires (7-day TTL).
    const expired = new Date(new Date(claim.tokenIssuedAt).getTime() + 8 * 24 * 60 * 60 * 1000)
    report = await runCatalogIngestTick(tickDeps({ fetchText, post, now: () => expired }))
    expect(report.ownershipExpired).toBe(1)
    expect((await row(claim.submissionId)).status).toBe('failed')
  })

  it('fails closed when CATALOG_OWNERSHIP_SECRET is unset — rows stay, nothing dials the network', async () => {
    const claim = await seed('nokey.example.com')
    const fetchText = vi.fn()
    const post = vi.fn()

    const report = await runCatalogIngestTick(tickDeps({ verifySecret: '', fetchText, post }))

    expect(report.acted).toBe(false)
    expect(fetchText).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect((await row(claim.submissionId)).status).toBe('submitted')
  })

  it('degrades a candidate to failed after the consecutive-failure threshold', async () => {
    const claim = await seed('broken.example.com')

    for (let i = 1; i <= FAIL_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      resetCatalogAlertStateForTests()
      const report = await runCatalogIngestTick(
        tickDeps({ fetchText: wellKnownServer(claim, SECRET), post: brokenMcp() }),
      )
      const saved = await row(claim.submissionId)
      if (i < FAIL_AFTER_CONSECUTIVE_FAILURES) {
        expect(saved.status).toBe('ownership_verified')
        expect(saved.consecutive_failures).toBe(i)
        expect(report.probedFailed).toBe(0) // not failed until the threshold
      } else {
        expect(saved.status).toBe('failed')
        expect(report.probedFailed).toBe(1)
      }
    }
  })

  it('degrades a previously-verified entry after stale re-verification failures', async () => {
    const claim = await seed('stale.example.com')
    const post = mcpServer()
    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post }))
    expect((await row(claim.submissionId)).status).toBe('verified_payable')

    // Merchant stops answering: backdate last_verified_at and make it broken.
    await db.query(`UPDATE catalog_submissions SET last_verified_at = now() - interval '2 days' WHERE id = $1`, [claim.submissionId])
    for (let i = 1; i <= FAIL_AFTER_CONSECUTIVE_FAILURES; i += 1) {
      resetCatalogAlertStateForTests()
      const report = await runCatalogIngestTick(
        tickDeps({ fetchText: wellKnownServer(claim, SECRET), post: brokenMcp() }),
      )
      const saved = await row(claim.submissionId)
      if (i === FAIL_AFTER_CONSECUTIVE_FAILURES) {
        expect(saved.status).toBe('failed')
        expect(report.degraded).toBe(1)
        expect(report.probedFailed).toBe(1)
      }
    }
  })

  it('re-probes a verified entry only after the re-verification cadence elapses', async () => {
    const claim = await seed('fresh.example.com')
    const post = vi.fn(mcpServer())
    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post }))
    const callsAfterVerify = post.mock.calls.length

    // Immediate next tick: not due, so no re-probe.
    const report = await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post }))
    expect(report.probedVerified).toBe(0)
    expect(post.mock.calls.length).toBe(callsAfterVerify)

    // Backdate past the cadence: due again.
    await db.query(`UPDATE catalog_submissions SET last_verified_at = now() - interval '2 days' WHERE id = $1`, [claim.submissionId])
    const re = await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post }))
    expect(re.probedVerified).toBe(1)
    expect(post.mock.calls.length).toBeGreaterThan(callsAfterVerify)
  })

  it('respects the per-hostname cooldown across consecutive ticks', async () => {
    const claim = await seed('cooldown.example.com')
    const post = vi.fn(mcpServer())
    const cooldown = new HostCooldown()

    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post, cooldown }))
    const callsAfterFirst = post.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Make the entry due for re-check AND keep the first tick's cooldown: the
    // tick must thread the shared cooldown through so the probe is skipped.
    await db.query(`UPDATE catalog_submissions SET last_verified_at = now() - interval '2 days' WHERE id = $1`, [claim.submissionId])
    const report = await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post, cooldown }))
    expect(report.skippedCooldown).toBe(1)
    expect(report.probedVerified).toBe(0)
    expect(post.mock.calls.length).toBe(callsAfterFirst)
  })

  it('purges terminal rows past the retention TTL', async () => {
    const claim = await seed('doomed.example.com')
    await db.query(
      `UPDATE catalog_submissions SET status = 'failed', failed_at = now() - interval '31 days', updated_at = now() - interval '31 days' WHERE id = $1`,
      [claim.submissionId],
    )
    const report = await runCatalogIngestTick(tickDeps({}))
    expect(report.purged).toBe(1)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM catalog_submissions`)
    expect(rows[0].n).toBe(0)
  })

  it('edge-triggers the stuck-submission alarm, once', async () => {
    const claim = await seed('stuck.example.com')
    await db.query(`UPDATE catalog_submissions SET created_at = now() - interval '3 days' WHERE id = $1`, [claim.submissionId])

    const first = await runCatalogIngestTick(tickDeps({}))
    expect(first.stuckSubmitted).toBe(1)
    expect(first.alerts.some((a) => a.includes('stuck'))).toBe(true)

    // Same condition on the next tick: no repeat alert.
    const second = await runCatalogIngestTick(tickDeps({}))
    expect(second.stuckSubmitted).toBe(1)
    expect(second.alerts).toHaveLength(0)
  })

  it('edge-triggers the mass-failure alarm at the configured threshold', () => {
    resetCatalogAlertStateForTests()
    expect(catalogAlerts({ stuckSubmitted: 0, failuresThisTick: 5, massFailureThreshold: 5, now: new Date() })).toHaveLength(1)
    // Same volume again: no repeat.
    expect(catalogAlerts({ stuckSubmitted: 0, failuresThisTick: 5, massFailureThreshold: 5, now: new Date() })).toHaveLength(0)
    // Back under threshold resets the edge.
    expect(catalogAlerts({ stuckSubmitted: 0, failuresThisTick: 1, massFailureThreshold: 5, now: new Date() })).toHaveLength(0)
  })

  it('reports no action and no alerts on an empty queue with a live secret', async () => {
    const report = await runCatalogIngestTick(tickDeps({ post: vi.fn() }))
    expect(report.acted).toBe(false)
    expect(report.alerts).toHaveLength(0)
  })
})
