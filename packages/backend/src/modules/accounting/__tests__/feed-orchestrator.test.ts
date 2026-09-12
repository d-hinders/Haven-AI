import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    accountingFeedAvailable: vi.fn(),
    buildAccountingEntryForPayment: vi.fn(),
    claimSync: vi.fn(),
    markPushed: vi.fn(),
    markFailed: vi.fn(),
    markSkipped: vi.fn(),
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
  markSkipped: mocks.markSkipped,
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
// #2867: the pure helpers (`connectionSettings`) stay real; only the data
// access is stubbed. A row without `settings` reads as the defaults.
vi.mock('../../../infra/repositories/accounting-connections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/repositories/accounting-connections.js')>()),
  ...connectionMocks,
}))

import { feedSettledPayment } from '../feed-orchestrator.js'
import { registerConnector, clearConnectors, InMemoryConnector, type AccountingConnector } from '../connector.js'
import { flagConnectionStatus, setOpsEventSink, REASON_PREFIX_MAX_LENGTH, type OpsEvent, type OpsEventLevel } from '../ops-signals.js'

const USER = 'u1'
const PID = 'pi1'

function entry(amountSek: string | null = '132.50') {
  return { paymentId: PID, settledAt: '2026-06-20', direction: 'out', counterparty: { address: '0xm', name: 'M' }, resourceUrl: 'r', token: 'USDC', amountAtomic: '1', amountSek, fxRate: '10', fxSource: 's', fxAt: 't', receiptRef: 'ev', account: null }
}

describe('feed orchestrator (#499)', () => {
  /** #2872: every ops event the run emitted, in order. */
  const events: Array<{ level: OpsEventLevel; event: OpsEvent }> = []
  /** How many status writes had happened when each event fired — the write must come first. */
  const setStatusCallsAtEmit: number[] = []

  beforeEach(() => {
    events.length = 0
    setStatusCallsAtEmit.length = 0
    setOpsEventSink((level, event) => {
      events.push({ level, event })
      setStatusCallsAtEmit.push(connectionMocks.setStatus.mock.calls.length)
    })
    clearConnectors()
    for (const m of Object.values(mocks)) m.mockReset()
    connectionMocks.getActiveConnection.mockReset().mockResolvedValue(null)
    connectionMocks.setStatus.mockReset().mockResolvedValue(undefined)
    mocks.claimSync.mockResolvedValue({ owned: true, status: 'pending' })
    mocks.markPushed.mockResolvedValue(undefined)
    mocks.markFailed.mockResolvedValue(undefined)
    mocks.buildAccountingEntryForPayment.mockResolvedValue(entry())
  })

  afterEach(() => {
    setOpsEventSink(null)
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
    // #2872: the flip is announced as the needs_attention event, AFTER the write.
    // #2905: the line carries the parseable head of the reason and the scope
    // list — never the connector's free-text detail (which on a Fortnox
    // supplier-lookup refusal embeds the recipient's name in the request path).
    expect(events).toEqual([
      {
        level: 'warn',
        event: {
          event: 'accounting.connection.needs_attention',
          userId: USER,
          provider: 'memory',
          status: 'scope_missing',
          reasonPrefix: 'missing scopes: attachments',
          missingScopes: ['attachments'],
        },
      },
    ])
    expect(JSON.stringify(events)).not.toMatch(/insufficient scope/)
    expect(Object.keys(events[0].event).sort()).toEqual(['event', 'missingScopes', 'provider', 'reasonPrefix', 'status', 'userId'])
    expect(setStatusCallsAtEmit).toEqual([1])
  })

  it('#2865: a PRE-push scope refusal (skipped + connectionStatus) records a skipped row AND flips the connection; a plain skip does not', async () => {
    mocks.accountingFeedAvailable.mockResolvedValue(true)
    const c = connectInMemory()
    c.invoiceOutcome = 'scope_missing'
    expect(await feedSettledPayment(USER, PID)).toEqual({ outcome: 'skipped', reason: expect.stringMatching(/scope refused before the record was created/) })
    expect(mocks.markSkipped).toHaveBeenCalledWith(USER, 'memory', PID, expect.stringMatching(/scope refused/))
    expect(connectionMocks.setStatus).toHaveBeenCalledWith(USER, 'memory', 'scope_missing', expect.stringMatching(/^missing scopes: invoice — scope refused/))
    expect(mocks.markPushed).not.toHaveBeenCalled()
    expect(c.pushed).toHaveLength(0)
    // #2872: MUTATION TARGET (ops-signals.ts flagConnectionStatus) — drop the
    // emit and this is the assertion that fails.
    expect(events.map((e) => [e.level, e.event.event, e.event.status])).toEqual([
      ['warn', 'accounting.connection.needs_attention', 'scope_missing'],
    ])
    expect(events[0].event).toMatchObject({ reasonPrefix: 'missing scopes: invoice', missingScopes: ['invoice'] })
    expect(events[0].event).not.toHaveProperty('reason')

    // Positive control: a skip that is NOT about the grant leaves the connection alone — and says nothing.
    connectionMocks.setStatus.mockClear()
    mocks.markSkipped.mockClear()
    events.length = 0
    c.invoiceOutcome = 'ok'
    mocks.buildAccountingEntryForPayment.mockResolvedValue({ ...entry('10.00'), direction: 'in' })
    await feedSettledPayment(USER, PID)
    expect(connectionMocks.setStatus).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('#2905: the needs_attention line is bounded — a 5000-char Fortnox reason with a recipient name in the path yields a short prefix and the scope list, the row keeps the full text', async () => {
    const detail = `fortnox request failed (HTTP 403 [2000663]) on /suppliers?name=Acme%20Recipient%20AB ${'x'.repeat(5000)}`
    const reason = `missing scopes: supplier, supplierinvoice — ${detail}`
    await flagConnectionStatus(USER, 'fortnox', 'scope_missing', reason)
    expect(connectionMocks.setStatus).toHaveBeenCalledWith(USER, 'fortnox', 'scope_missing', reason)
    expect(events).toHaveLength(1)
    const line = events[0].event
    expect(line).toMatchObject({ reasonPrefix: 'missing scopes: supplier, supplierinvoice', missingScopes: ['supplier', 'supplierinvoice'] })
    expect((line.reasonPrefix as string).length).toBeLessThanOrEqual(REASON_PREFIX_MAX_LENGTH)
    expect(JSON.stringify(line)).not.toMatch(/Acme|suppliers\?name|xxxx/)
    // A reason with no separator (the refused-refresh shape) is still capped, never the 1000-char row text.
    events.length = 0
    await flagConnectionStatus(USER, 'fortnox', 'needs_reauthorisation', `refresh refused: ${'y'.repeat(2000)}`)
    expect((events[0].event.reasonPrefix as string).length).toBe(REASON_PREFIX_MAX_LENGTH)
    expect(events[0].event.missingScopes).toEqual([])
    // A null reason stays null.
    events.length = 0
    await flagConnectionStatus(USER, 'fortnox', 'revoked_at_provider', null)
    expect(events[0].event).toMatchObject({ reasonPrefix: null, missingScopes: [] })
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
