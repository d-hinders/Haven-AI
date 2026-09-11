import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    accountingFeedAvailable: vi.fn(),
    buildAccountingEntryForPayment: vi.fn(),
    claimSync: vi.fn(),
    markPushed: vi.fn(),
    markFailed: vi.fn(),
    listSyncs: vi.fn(),
  },
}))

vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
// #2859: `feed-orchestrator.ts` imports this from the module's own
// `entry.js`, not from a sibling module's barrel — a mock left on the old
// specifier is silently inert and the real DB query runs.
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../feed-sync.js', () => ({
  claimSync: mocks.claimSync,
  markPushed: mocks.markPushed,
  markFailed: mocks.markFailed,
  listSyncs: mocks.listSyncs,
}))
// #2862: the orchestrator resolves the ACTIVE destination from the
// connections table first. No row AT ALL here (`listConnections` → []) → it
// falls back to the first registered connector that reports the user
// connected (the in-memory one). A row-backed user never takes that path
// (feed-from.db.test.ts, review on #2894).
const connectionMocks = vi.hoisted(() => ({
  getActiveConnection: vi.fn(async () => null),
  listConnections: vi.fn(async () => []),
  setStatus: vi.fn(async () => {}),
}))
vi.mock('../../../infra/repositories/accounting-connections.js', () => connectionMocks)

import { feedSettledPayment } from '../feed-orchestrator.js'
import { registerConnector, clearConnectors, InMemoryConnector, type AccountingConnector } from '../connector.js'

const USER = 'u1'
const PID = 'pi1'

function entry(amountSek: string | null = '132.50') {
  return { paymentId: PID, settledAt: '2026-06-20', direction: 'out', counterparty: { address: '0xm', name: 'M' }, resourceUrl: 'r', token: 'USDC', amountAtomic: '1', amountSek, fxRate: '10', fxSource: 's', fxAt: 't', receiptRef: 'ev', account: null }
}

describe('feed orchestrator (#499)', () => {
  beforeEach(() => {
    clearConnectors()
    for (const m of Object.values(mocks)) m.mockReset()
    connectionMocks.getActiveConnection.mockReset().mockResolvedValue(null)
    connectionMocks.setStatus.mockReset().mockResolvedValue(undefined)
    mocks.claimSync.mockResolvedValue({ owned: true, status: 'pending' })
    mocks.markPushed.mockResolvedValue(undefined)
    mocks.markFailed.mockResolvedValue(undefined)
    mocks.buildAccountingEntryForPayment.mockResolvedValue(entry())
  })

  function connectInMemory(): InMemoryConnector {
    const c = new InMemoryConnector()
    c.connect(USER)
    registerConnector(c)
    return c
  }

  it('no-ops when the feed is unavailable', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(false)
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(0)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('no-ops when no connector is connected', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    // no connector registered
    await feedSettledPayment(USER, PID)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('pushes a ready payment and marks it pushed', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(1)
    expect(mocks.markPushed).toHaveBeenCalledWith(USER, 'memory', PID, 'memory:invoice:1', null)
    expect(connectionMocks.setStatus).not.toHaveBeenCalled()
  })

  it('#2862: uses the ACTIVE connection\'s provider and feeds nothing settled before its feed_from', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    const c = connectInMemory()
    connectionMocks.getActiveConnection.mockResolvedValue({ provider: 'memory', feed_from: new Date('2026-07-01T00:00:00.000Z') } as never)
    await feedSettledPayment(USER, PID) // entry settledAt 2026-06-20 — before the floor
    expect(c.pushed).toHaveLength(0)
    expect(mocks.claimSync).not.toHaveBeenCalled()

    connectionMocks.getActiveConnection.mockResolvedValue({ provider: 'memory', feed_from: new Date('2026-06-01T00:00:00.000Z') } as never)
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(1)
  })

  it('#2862: an active row whose connector is not registered feeds nowhere — no silent fallback to another provider', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    connectInMemory()
    connectionMocks.getActiveConnection.mockResolvedValue({ provider: 'accounted', feed_from: null } as never)
    await feedSettledPayment(USER, PID)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('#2862: a post-push connectionStatus flips the connection, and the row is still marked pushed', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    const c = connectInMemory()
    c.attachmentOutcome = 'scope_missing'
    await feedSettledPayment(USER, PID)
    expect(mocks.markPushed).toHaveBeenCalledWith(USER, 'memory', PID, 'memory:invoice:1', expect.stringMatching(/insufficient scope/))
    expect(connectionMocks.setStatus).toHaveBeenCalledWith(USER, 'memory', 'scope_missing', expect.stringMatching(/insufficient scope/))
    expect(mocks.markFailed).not.toHaveBeenCalled()
  })

  it('skips (no claim) when book-time SEK is missing', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockResolvedValue(entry(null))
    connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('does not push when the claim is not owned (dedup)', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    mocks.claimSync.mockResolvedValue({ owned: false, status: 'pushed' })
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(0)
    expect(mocks.markPushed).not.toHaveBeenCalled()
  })

  it('marks failed (without throwing) when the push errors', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    const throwing: AccountingConnector = {
      provider: 'fortnox',
      isConnected: async () => true,
      pushTransaction: async () => { throw new Error('fortnox down') },
      verify: async () => ({ ok: false, error_code: 'not_connected' }),
      getCompanyInfo: async () => ({ externalCompanyId: null, name: null, baseCurrency: null }),
      revoke: async () => {},
    }
    registerConnector(throwing)
    // #2866: the outcome carries the thrown error so the retry sweep can
    // tell a provider 429 from anything else; nothing is thrown at the caller.
    const err = new Error('fortnox down')
    throwing.pushTransaction = async () => { throw err }
    await expect(feedSettledPayment(USER, PID)).resolves.toEqual({ outcome: 'failed', reason: 'fortnox down', error: err })
    expect(mocks.markFailed).toHaveBeenCalledWith(USER, 'fortnox', PID, 'fortnox down')
  })
})
