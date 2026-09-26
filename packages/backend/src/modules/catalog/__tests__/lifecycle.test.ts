/**
 * Catalogue ingestion lifecycle tests (#1714, epic #1717).
 *
 * The tick is tested against a REAL migrated Postgres (epic #1219) with only
 * the network stubbed — the ownership fetcher and the JSON-RPC probe are
 * injected, exactly as in the ownership/probe slice tests. That keeps the
 * DB claims (guarded transitions, streaks, retention) real while the hostile
 * half of the world (the merchant endpoint) stays fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { insertCatalogSubmission, listSubmittedCatalogSubmissions } from '../../../infra/repositories/catalog-submissions.js'
import { findOrCreateMerchantByHost } from '../../../infra/repositories/merchants.js'
import type { SafeFetchResult } from '../../../infra/http/ssrf-guard.js'
import type { EnvAlertDelivery } from '../../../infra/delegate-alert-webhook.js'
import {
  FAIL_AFTER_CONSECUTIVE_FAILURES,
  REVERIFY_CADENCE_MS,
  HostCooldown,
  expectedProofPayload,
  type OwnershipClaim,
} from '../index.js'
import {
  catalogAlerts,
  deliverCatalogAlerts,
  resetCatalogAlertStateForTests,
  runCatalogIngestTick,
  type CatalogIngestDeps,
} from '../lifecycle.js'

const SECRET = 'test-ownership-secret-not-a-real-key'
const TOKEN = 'ab'.repeat(24)

async function seed(
  hostname: string,
  resourceUrl?: string,
  merchant: { merchant_name?: string; merchant_website?: string } = {},
): Promise<OwnershipClaim> {
  const created = await insertCatalogSubmission({
    hostname,
    resource_url: resourceUrl ?? `https://${hostname}/mcp`,
    submitter_ip: '127.0.0.1',
    verify_token: TOKEN,
    queueCap: 10_000,
    ...merchant,
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
    // #3078: a verified offer belongs to a merchant — founded here from the
    // probe's own name, since nobody owned the host and the submitter said
    // nothing about the seller.
    expect(saved.merchant_id).toBeTruthy()
    const merchant = await db.query<{ slug: string; name: string; listing_status: string }>(
      `SELECT slug, name, listing_status FROM merchants WHERE id = $1`,
      [saved.merchant_id],
    )
    expect(merchant.rows[0]).toEqual({ slug: 'summarizer', name: 'Summarizer', listing_status: 'live' })
  })

  it('attaches a verified submission to the merchant that already owns its host, and founds one from merchant_name otherwise (#3078)', async () => {
    // A curated merchant already answers on this host through a catalog row:
    // the submission joins it, the submitter's name is ignored.
    const owner = await findOrCreateMerchantByHost('shop.example.com', { name: 'Shop Co' })
    await db.query(
      `INSERT INTO merchant_catalog
         (name, description, category, resource_url, rail, protocol, tool_name, network, status, merchant_id)
       VALUES ('Shop tool', 'x', 'api', 'https://shop.example.com/paid', 'x402', 'http', NULL, 'eip155:8453', 'active', $1)`,
      [owner.id],
    )
    const claim = await seed('shop.example.com', undefined, { merchant_name: 'Impostor Ltd', merchant_website: 'https://impostor.example' })
    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim, SECRET), post: mcpServer() }))
    const joined = await row(claim.submissionId)
    expect(joined.status).toBe('verified_payable')
    expect(joined.merchant_id).toBe(owner.id)
    const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM merchants`)
    expect(count.rows[0].n).toBe('1')

    // Nobody owns this host: the submitter's merchant_name and website found the merchant.
    const claim2 = await seed('new.example.com', undefined, { merchant_name: 'New Seller AB', merchant_website: 'https://new.example.com' })
    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim2, SECRET), post: mcpServer() }))
    const founded = await row(claim2.submissionId)
    const m = await db.query<{ slug: string; name: string; website: string | null }>(
      `SELECT slug, name, website FROM merchants WHERE id = $1`,
      [founded.merchant_id],
    )
    expect(m.rows[0]).toEqual({ slug: 'new-seller-ab', name: 'New Seller AB', website: 'https://new.example.com' })

    // A re-verification keeps the merchant it has.
    await runCatalogIngestTick(tickDeps({ fetchText: wellKnownServer(claim2, SECRET), post: mcpServer() }))
    expect((await row(claim2.submissionId)).merchant_id).toBe(founded.merchant_id)
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

describe('deliverCatalogAlerts — a failed webhook re-arms the alarm (#3345)', () => {
  const stuckTick = { stuckSubmitted: 2, failuresThisTick: 0, massFailureThreshold: 5, now: new Date() }

  beforeEach(() => {
    resetCatalogAlertStateForTests()
  })

  it('a failed send rolls the edge back: the same condition re-fires on the next tick', async () => {
    const send = vi.fn<(text: string) => Promise<EnvAlertDelivery>>().mockResolvedValue('failed')

    const first = catalogAlerts(stuckTick)
    expect(first).toHaveLength(1)
    await deliverCatalogAlerts(first, send)

    // The bug (#3345) committed the edge before sending → this would be 0
    // while submissions stay stuck past 48h with a dead webhook.
    const second = catalogAlerts(stuckTick)
    expect(second).toHaveLength(1)
    // The re-fired alarm is delivered too (and re-arms again if that fails).
    await deliverCatalogAlerts(second, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a delivered send commits the edge: no repeat while the condition persists', async () => {
    const send = vi.fn<(text: string) => Promise<EnvAlertDelivery>>().mockResolvedValue('delivered')

    const first = catalogAlerts(stuckTick)
    expect(first).toHaveLength(1)
    await deliverCatalogAlerts(first, send)

    expect(catalogAlerts(stuckTick)).toHaveLength(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("'no-webhook' (log-only mode) counts as handled — no repeat, matching the pre-#3345 behaviour", async () => {
    const send = vi.fn<(text: string) => Promise<EnvAlertDelivery>>().mockResolvedValue('no-webhook')

    const first = catalogAlerts(stuckTick)
    expect(first).toHaveLength(1)
    await deliverCatalogAlerts(first, send)

    expect(catalogAlerts(stuckTick)).toHaveLength(0)
  })

  it('a failed send in a batch re-arms the batch: the next tick re-fires the failed alarm', async () => {
    // Both alarms fire in one batch: stuck (delivered) + mass failure (failed).
    // Queued verdicts, no positional chain (the db-mock ratchet counts
    // mockResolvedValueOnce).
    const verdicts: EnvAlertDelivery[] = ['delivered', 'failed']
    const send = vi
      .fn<(text: string) => Promise<EnvAlertDelivery>>()
      .mockImplementation(async () => verdicts.shift() ?? 'delivered')

    const batch = catalogAlerts({ stuckSubmitted: 1, failuresThisTick: 5, massFailureThreshold: 5, now: new Date() })
    expect(batch).toHaveLength(2)
    await deliverCatalogAlerts(batch, send)

    // The catalog state is one shared flag pair, so the reset on a failed
    // send is batch-level: the next tick re-fires every alarm whose condition
    // still holds — here both (stuck AND mass failure), since neither edge
    // survived a batch containing a failed send. The delegate monitor carries
    // the per-message partial-batch semantics; the catalog seam
    // (resetCatalogAlertStateForTests) has no per-alarm granularity.
    const again = catalogAlerts({ stuckSubmitted: 1, failuresThisTick: 5, massFailureThreshold: 5, now: new Date() })
    expect(again).toHaveLength(2)
    expect(again.some((a) => a.includes('failed this tick'))).toBe(true)
  })
})
