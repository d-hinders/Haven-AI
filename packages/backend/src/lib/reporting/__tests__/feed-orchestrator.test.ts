import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    reportingFeedAvailable: vi.fn(),
    buildAccountingEntryForPayment: vi.fn(),
    claimSync: vi.fn(),
    markPushed: vi.fn(),
    markFailed: vi.fn(),
    listSyncs: vi.fn(),
  },
}))

vi.mock('../../entitlements.js', () => ({ reportingFeedAvailable: mocks.reportingFeedAvailable }))
vi.mock('../../accounting-entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../feed-sync.js', () => ({
  claimSync: mocks.claimSync,
  markPushed: mocks.markPushed,
  markFailed: mocks.markFailed,
  listSyncs: mocks.listSyncs,
}))

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
    mocks.reportingFeedAvailable.mockResolvedValue(false)
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(0)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('no-ops when no connector is connected', async () => {
    mocks.reportingFeedAvailable.mockResolvedValue(true)
    // no connector registered
    await feedSettledPayment(USER, PID)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('pushes a ready payment and marks it pushed', async () => {
    mocks.reportingFeedAvailable.mockResolvedValue(true)
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(1)
    expect(mocks.markPushed).toHaveBeenCalledWith(USER, 'memory', PID, `mem:${USER}:${PID}`)
  })

  it('skips (no claim) when book-time SEK is missing', async () => {
    mocks.reportingFeedAvailable.mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockResolvedValue(entry(null))
    connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(mocks.claimSync).not.toHaveBeenCalled()
  })

  it('does not push when the claim is not owned (dedup)', async () => {
    mocks.reportingFeedAvailable.mockResolvedValue(true)
    mocks.claimSync.mockResolvedValue({ owned: false, status: 'pushed' })
    const c = connectInMemory()
    await feedSettledPayment(USER, PID)
    expect(c.pushed).toHaveLength(0)
    expect(mocks.markPushed).not.toHaveBeenCalled()
  })

  it('marks failed (without throwing) when the push errors', async () => {
    mocks.reportingFeedAvailable.mockResolvedValue(true)
    const throwing: AccountingConnector = {
      provider: 'fortnox',
      isConnected: async () => true,
      pushTransaction: async () => { throw new Error('fortnox down') },
    }
    registerConnector(throwing)
    await expect(feedSettledPayment(USER, PID)).resolves.toBeUndefined()
    expect(mocks.markFailed).toHaveBeenCalledWith(USER, 'fortnox', PID, 'fortnox down')
  })
})
