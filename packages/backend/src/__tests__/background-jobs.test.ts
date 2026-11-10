/**
 * The background-job table (#4764).
 *
 * `index.ts` used to start ten jobs inline, so the only way to prove the
 * wiring was to regex its source — a technique that failed once on record
 * (#4411). The table is now importable, so these are behavioural assertions:
 * the exact set of rows, their intervals as literal milliseconds, their lock
 * keys, the one deliberate per-replica row, and the catalog-ingest monitor's
 * lifetime.
 *
 * The intervals are asserted as NUMBERS, never by importing the constants the
 * table file defines — a test that read `CATALOG_INGEST_INTERVAL_MS` back from
 * the table would stay green through a mutation of that constant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCatalogIngestMonitor: vi.fn(),
  monitorTick: vi.fn(),
  deliverCatalogAlerts: vi.fn(),
  ingestDiscoveredCatalog: vi.fn(),
  refreshCatalog: vi.fn(),
  startJobs: vi.fn(),
  startRetrySweep: vi.fn(),
}))

vi.mock('../modules/catalog/index.js', () => ({
  createCatalogIngestMonitor: mocks.createCatalogIngestMonitor,
  deliverCatalogAlerts: mocks.deliverCatalogAlerts,
  ingestDiscoveredCatalog: mocks.ingestDiscoveredCatalog,
  refreshCatalog: mocks.refreshCatalog,
}))

vi.mock('../modules/accounting/index.js', () => ({
  startRetrySweep: mocks.startRetrySweep,
}))

vi.mock('../platform/job-scheduler.js', () => ({
  startJobs: mocks.startJobs,
}))

import { createBackgroundJobs, startBackgroundJobs } from '../background-jobs.js'
import { LEADER_LOCK_KEYS } from '../platform/leader-lock.js'

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const pool = { query: vi.fn(async () => ({ rows: [] })) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.monitorTick.mockResolvedValue({
    ownershipVerified: 0,
    ownershipExpired: 0,
    probedVerified: 0,
    probedFailed: 0,
    degraded: 0,
    skippedCooldown: 0,
    purged: 0,
    stuckSubmitted: 0,
    acted: false,
    alerts: [],
  })
  mocks.createCatalogIngestMonitor.mockImplementation(() => ({ tick: mocks.monitorTick }))
  mocks.deliverCatalogAlerts.mockResolvedValue(undefined)
})

describe('the background-job table', () => {
  it('is exactly these ten jobs — a removed or added row fails', () => {
    const rows = createBackgroundJobs({ log, pool })
    expect(rows.map((r) => r.name).sort()).toEqual([
      'catalog ingest',
      'catalog refresh',
      'delegate balance monitor',
      'feedback sweep',
      'outbound bump',
      'passport sweep',
      'rate-limit sweep',
      'relayer balance monitor',
      'settlement sweep',
      'submission reconcile',
    ])
  })

  it('carries each interval as a literal number of milliseconds', () => {
    const rows = createBackgroundJobs({ log, pool })
    expect(Object.fromEntries(rows.map((r) => [r.name, r.intervalMs]))).toEqual({
      'catalog refresh': 3_600_000,
      'catalog ingest': 300_000,
      'rate-limit sweep': 300_000,
      'feedback sweep': 300_000,
      'delegate balance monitor': 3_600_000,
      'relayer balance monitor': 3_600_000,
      'outbound bump': 60_000,
      'settlement sweep': 120_000,
      'submission reconcile': 60_000,
      'passport sweep': 300_000,
    })
  })

  it("carries each row's leader lock key", () => {
    const rows = createBackgroundJobs({ log, pool })
    expect(Object.fromEntries(rows.map((r) => [r.name, r.lockKey]))).toEqual({
      'catalog refresh': LEADER_LOCK_KEYS.catalogRefresh,
      'catalog ingest': LEADER_LOCK_KEYS.catalogIngest,
      'rate-limit sweep': LEADER_LOCK_KEYS.rateLimitSweep,
      'feedback sweep': LEADER_LOCK_KEYS.feedbackSweep,
      'delegate balance monitor': LEADER_LOCK_KEYS.delegateBalanceMonitor,
      'relayer balance monitor': undefined,
      'outbound bump': LEADER_LOCK_KEYS.outboundBump,
      'settlement sweep': LEADER_LOCK_KEYS.settlementSweep,
      'submission reconcile': LEADER_LOCK_KEYS.submissionReconcile,
      'passport sweep': LEADER_LOCK_KEYS.passportSweep,
    })
  })

  it('makes the relayer balance monitor the ONLY per-replica row, and never uses its unused key', () => {
    const rows = createBackgroundJobs({ log, pool })

    expect(rows.filter((r) => r.lockKey === undefined).map((r) => r.name)).toEqual([
      'relayer balance monitor',
    ])
    // `LEADER_LOCK_KEYS.relayerBalanceMonitor` exists but must stay unused:
    // the scan feeds each replica's own /health/ops answer.
    expect(rows.some((r) => r.lockKey === LEADER_LOCK_KEYS.relayerBalanceMonitor)).toBe(false)

    const keys = rows.filter((r) => r.lockKey !== undefined).map((r) => r.lockKey)
    expect(keys).toHaveLength(9)
    expect(new Set(keys).size).toBe(9)
  })

  it('builds the catalog-ingest monitor ONCE and holds it across ticks (#4407)', async () => {
    const rows = createBackgroundJobs({ log, pool })
    const ingest = rows.find((r) => r.name === 'catalog ingest')
    expect(ingest).toBeDefined()

    await ingest!.run()
    await ingest!.run()

    // The monitor owns the per-host probe cooldown. Rebuilding it per tick
    // would reset the cooldown every 5 minutes and let a failing merchant be
    // probed on every tick — the #4407 defect.
    expect(mocks.createCatalogIngestMonitor).toHaveBeenCalledTimes(1)
    expect(mocks.monitorTick).toHaveBeenCalledTimes(2)
  })
})

describe('startBackgroundJobs', () => {
  it('starts all ten rows and calls startRetrySweep exactly once', () => {
    startBackgroundJobs({ log, pool })

    expect(mocks.startJobs).toHaveBeenCalledTimes(1)
    const [rows, deps] = mocks.startJobs.mock.calls[0]!
    expect(rows).toHaveLength(10)
    expect(deps.log).toBe(log)

    // The eleventh job is NOT a row: it self-registers inside
    // `modules/accounting/retry-sweep.ts` and is called from the entry point.
    expect(mocks.startRetrySweep).toHaveBeenCalledTimes(1)
    expect(mocks.startRetrySweep).toHaveBeenCalledWith({ log })
  })
})
