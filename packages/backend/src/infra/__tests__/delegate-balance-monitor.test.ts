import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const { mockQuery, mockGetTokenBalance } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetTokenBalance: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../infra/chain/relayer-reads.js', () => ({
  getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
}))

const {
  classifyDelegateBalance,
  computeAlerts,
  newAlertState,
  resetDelegateAlertStateForTests,
  runDelegateBalanceMonitor,
  scanDelegateBalances,
  sweepFloorAtomic,
} = await import('../delegate-balance-monitor.js')

const FLOOR = ethers.parseUnits('0.01', 6) // config default sweepMinUsdc='0.01'

// A fake hook URL shape — never a real one, and never asserted to appear in logs.
const WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/secrettoken'

function delegateRow(n: number, chainId = 8453) {
  return {
    agent_id: `agent-${n}`,
    agent_name: `Agent ${n}`,
    delegate_address: `0x${String(n).repeat(2).padStart(2, '0')}${'ab'.repeat(19)}`,
    chain_id: chainId,
  }
}

function httpRes(ok: boolean, status: number, body = ''): Response {
  return { ok, status, text: async () => body } as unknown as Response
}

/**
 * Mock the monitor's two repository queries WITHOUT positional chains for NEW
 * tests (`mockResolvedValueOnce` is ratchet-counted and this file sits at its
 * baseline). The SQL is matched by marker, not call order.
 */
function mockDelegates(rows: ReturnType<typeof delegateRow>[], freshAgentIds: string[] = []): void {
  mockQuery.mockImplementation((sql: unknown) => {
    const text = String(sql)
    if (text.includes('FROM agents')) return Promise.resolve({ rows })
    if (text.includes('payment_intents')) {
      return Promise.resolve({ rows: freshAgentIds.map((agent_id) => ({ agent_id })) })
    }
    return Promise.reject(new Error(`unexpected query: ${text.slice(0, 80)}`))
  })
}

beforeEach(() => {
  mockQuery.mockReset()
  mockGetTokenBalance.mockReset()
  resetDelegateAlertStateForTests()
  delete process.env.DELEGATE_DUST_ALERT_USDC
  delete process.env.DELEGATE_ALERT_WEBHOOK_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyDelegateBalance — the state table', () => {
  it.each([
    ['clear at zero', 0n, false, 'clear'],
    ['in_flight when funded with a fresh pending payment', FLOOR * 2n, true, 'in_flight'],
    ['dust below the floor', FLOOR - 1n, false, 'dust'],
    ['lingering at the floor with no pending payment', FLOOR, false, 'lingering'],
    ['lingering above the floor', FLOOR * 10n, false, 'lingering'],
  ])('%s', (_label, balance, fresh, expected) => {
    expect(classifyDelegateBalance(balance, FLOOR, fresh)).toBe(expected)
  })

  it('dust with a fresh pending payment still reads in_flight (funding may be partial)', () => {
    expect(classifyDelegateBalance(FLOOR - 1n, FLOOR, true)).toBe('in_flight')
  })
})

describe('scanDelegateBalances', () => {
  it('classifies per delegate, aggregates dust, flags lingering', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1), delegateRow(2), delegateRow(3), delegateRow(4)] })
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-3' }] }) // agent-3 has a fresh payment
    mockGetTokenBalance
      .mockResolvedValueOnce(0n) // agent-1: clear
      .mockResolvedValueOnce(ethers.parseUnits('0.004', 6)) // agent-2: dust
      .mockResolvedValueOnce(ethers.parseUnits('3', 6)) // agent-3: in_flight (fresh payment)
      .mockResolvedValueOnce(ethers.parseUnits('2', 6)) // agent-4: lingering

    const report = await scanDelegateBalances()
    expect(report.findings.map((f) => f.state)).toEqual(['clear', 'dust', 'in_flight', 'lingering'])
    expect(report.dustTotalAtomic).toBe(ethers.parseUnits('0.004', 6))
    expect(report.dustAlert).toBe(false) // default threshold 25 USDC
    expect(report.lingering).toHaveLength(1)
    expect(report.lingering[0].agentId).toBe('agent-4')
  })

  it('alerts when aggregate dust passes the threshold', async () => {
    process.env.DELEGATE_DUST_ALERT_USDC = '0.01'
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1), delegateRow(2), delegateRow(3)] })
      .mockResolvedValueOnce({ rows: [] })
    // three delegates × 0.004 USDC dust = 0.012 ≥ 0.01 threshold
    mockGetTokenBalance.mockResolvedValue(ethers.parseUnits('0.004', 6))

    const report = await scanDelegateBalances()
    expect(report.dustTotalAtomic).toBe(ethers.parseUnits('0.012', 6))
    expect(report.dustAlert).toBe(true)
  })

  it('skips delegates whose balance read fails — a flaky RPC never kills the scan', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1), delegateRow(2)] })
      .mockResolvedValueOnce({ rows: [] })
    mockGetTokenBalance
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce(0n)

    const report = await scanDelegateBalances()
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].agentId).toBe('agent-2')
  })

  it('is read-only: only SELECTs, never writes', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1)] })
      .mockResolvedValueOnce({ rows: [] })
    mockGetTokenBalance.mockResolvedValueOnce(0n)
    await scanDelegateBalances()
    for (const [sql] of mockQuery.mock.calls) {
      expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true)
    }
  })
})

describe('runDelegateBalanceMonitor — log-based alerting', () => {
  it('WARNs per lingering balance and INFO-summarizes', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1)] })
      .mockResolvedValueOnce({ rows: [] })
    mockGetTokenBalance.mockResolvedValueOnce(ethers.parseUnits('2', 6))

    const log = { info: vi.fn(), warn: vi.fn() }
    await runDelegateBalanceMonitor(log)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const [obj, msg] = log.warn.mock.calls[0]
    expect(obj).toMatchObject({ scope: 'delegate-balance-monitor', balanceUsdc: '2.0' })
    expect(msg).toContain('LINGERING')
    expect(log.info).toHaveBeenCalledOnce()
  })

  it('stays quiet (info only) when everything is clear', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [delegateRow(1)] })
      .mockResolvedValueOnce({ rows: [] })
    mockGetTokenBalance.mockResolvedValueOnce(0n)

    const log = { info: vi.fn(), warn: vi.fn() }
    await runDelegateBalanceMonitor(log)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('sweepFloorAtomic', () => {
  it('derives from config.sweepMinUsdc (the #712 floor)', () => {
    expect(sweepFloorAtomic()).toBe(FLOOR)
  })
})

describe('computeAlerts — edge-triggered, not spammy (#777)', () => {
  function report(overrides: Record<string, unknown> = {}) {
    return {
      findings: [],
      dustTotalAtomic: 0n,
      dustAlert: false,
      lingering: [],
      scannedAt: '',
      ...overrides,
    } as never
  }
  function lingeringFinding(n: number) {
    return {
      agentId: `agent-${n}`,
      agentName: `Agent ${n}`,
      delegateAddress: `0x${String(n).repeat(2).padStart(2, '0')}${'ab'.repeat(19)}`,
      chainId: 8453,
      balanceAtomic: ethers.parseUnits('2', 6),
      state: 'lingering',
    }
  }

  it('pings a lingering finding once, stays silent while it persists', () => {
    const r = report({ lingering: [lingeringFinding(1)] })
    const first = computeAlerts(r, newAlertState())
    expect(first).toHaveLength(1)
    expect(first[0].text).toContain('Lingering')
    expect(first[0].clearLingeringKey).toBe('agent-1:8453')
    // same finding next scan → no new message
    const state = newAlertState()
    state.lingeringKeys.add('agent-1:8453')
    expect(computeAlerts(r, state)).toHaveLength(0)
  })

  it('re-pings after the balance clears and returns', () => {
    const r = report({ lingering: [lingeringFinding(1)] })
    const state = newAlertState()
    state.lingeringKeys.add('agent-1:8453')
    // cleared (the caller drops the key once the report has no findings)
    const cleared = computeAlerts(report({ lingering: [] }), state)
    expect(cleared).toHaveLength(0)
    // returns with the key forgotten → pings again
    const back = computeAlerts(r, newAlertState())
    expect(back).toHaveLength(1)
  })

  it('pings the dust breach only on the below→above crossing', () => {
    const breach = report({ dustAlert: true, dustTotalAtomic: ethers.parseUnits('30', 6) })
    const cross = computeAlerts(breach, newAlertState())
    expect(cross.some((m) => m.text.includes('dust'))).toBe(true)
    expect(cross.find((m) => m.text.includes('dust'))?.commitDust).toBe(true)
    // still above → no repeat
    const state = newAlertState()
    state.dustActive = true
    expect(computeAlerts(breach, state)).toHaveLength(0)
  })

  it('pings each distinct lingering delegate, keyed on agent+chain', () => {
    const r = report({ lingering: [lingeringFinding(1), lingeringFinding(2)] })
    const messages = computeAlerts(r, newAlertState())
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.clearLingeringKey)).toEqual(['agent-1:8453', 'agent-2:8453'])
  })
})

describe('runDelegateBalanceMonitor — webhook delivery gates the edge (#3345)', () => {
  function lingeringOnly(n: number): void {
    process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
    mockDelegates([delegateRow(n)])
    mockGetTokenBalance.mockResolvedValue(ethers.parseUnits('2', 6))
  }
  /** agent-4 lingering + a dust breach (3 × 0.004 = 0.012 ≥ 0.01 threshold). */
  function lingeringAndDust(): void {
    process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
    process.env.DELEGATE_DUST_ALERT_USDC = '0.01'
    mockDelegates([delegateRow(4), delegateRow(5), delegateRow(6), delegateRow(7)])
    mockGetTokenBalance.mockImplementation((chainId: unknown, addr: unknown) => {
      const address = String(addr)
      // delegateRow(4) mints a 0x44… address (lingering); rows 5-7 are dust.
      return Promise.resolve(
        address.startsWith('0x44') ? ethers.parseUnits('2', 6) : ethers.parseUnits('0.004', 6),
      )
    })
  }

  it('a 404: one post, the failure logged by the sender, the scan itself unaffected', async () => {
    lingeringOnly(4)
    const fetchMock = vi.fn().mockResolvedValue(httpRes(false, 404, 'nope'))
    vi.stubGlobal('fetch', fetchMock)

    const warn = vi.fn()
    const info = vi.fn()
    await runDelegateBalanceMonitor({ info, warn })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const messages = warn.mock.calls.map((c) => c[1] as string)
    expect(messages.some((m) => m.includes('ops alert webhook failed'))).toBe(true)
    expect(messages.some((m) => m.includes('404'))).toBe(true)
    // The scan completed normally — the failed alert never surfaced as a
    // failed scan, and every warn stays inside the monitor's scope.
    expect(info.mock.calls.some((c) => c[1] === 'delegate balance scan complete')).toBe(true)
    expect(warn.mock.calls.every((c) => (c[0] as Record<string, unknown>).scope === 'delegate-balance-monitor')).toBe(true)
  })

  it('MUTATION: a 404 with the lingering condition persisting retries on the next scan', async () => {
    // The bug (#3345): state committed before sending → run 2 posts nothing
    // and the alert is lost while sweepable funds keep sitting on the EOA.
    lingeringOnly(4)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(false, 404)))
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })

    const fetchMock = vi.fn().mockResolvedValue(httpRes(false, 404))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a network error: logged by the sender, retried on the next scan', async () => {
    lingeringOnly(4)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const warn = vi.fn()
    await runDelegateBalanceMonitor({ info: vi.fn(), warn })

    expect(warn.mock.calls.some((c) => String(c[1]).includes('network error'))).toBe(true)

    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retry-then-success: delivered on the second scan, silent on the third', async () => {
    lingeringOnly(4)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(false, 404)))
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })

    const fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const fetchMock3 = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock3)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock3).not.toHaveBeenCalled()
  })

  it('a full batch delivered: both messages post in one scan and each commits its own edge', async () => {
    lingeringAndDust()
    const fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(2) // lingering + dust messages

    // Next scan: BOTH edges committed by their own deliveries → silent.
    // (The per-condition partial case — one delivery failing — is the test
    // below, which is the one that kills the commit-before-send mutation.)
    const fetchMock2 = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock2)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock2).not.toHaveBeenCalled()
  })

  it('a failed send in a batch re-arms ONLY the failed condition on the next scan', async () => {
    lingeringAndDust()
    // lingering post fails, dust post succeeds — queued verdicts, no
    // positional chain (the db-mock ratchet counts mockResolvedValueOnce)
    const verdicts: Array<[boolean, number]> = [
      [false, 500], // lingering
      [true, 200], // dust
    ]
    const fetchMock = vi.fn().mockImplementation(() => {
      const [ok, status] = verdicts.shift() ?? [true, 200]
      return Promise.resolve(httpRes(ok, status))
    })
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Next scan: only the LINGERING message must re-fire.
    const fetchMock2 = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock2)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock2).toHaveBeenCalledTimes(1)
    const text = JSON.parse(String((fetchMock2.mock.calls[0] as [string, RequestInit])[1].body)).text as string
    expect(text).toContain('Lingering')
  })

  it('with the URL unset nothing is sent and log-only mode handles the episode (pre-#3345 behaviour)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    lingeringOnly(4)
    delete process.env.DELEGATE_ALERT_WEBHOOK_URL
    const warn = vi.fn()
    await runDelegateBalanceMonitor({ info: vi.fn(), warn })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[1]).includes('LINGERING'))).toBe(true)

    // Log-only mode handled the episode: enabling the webhook on the NEXT
    // scan must not re-send for the same continuous lingering episode. (The
    // per-finding LINGERING log warn itself fires every scan by design — the
    // edge gates only the webhook.)
    process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recovery re-arms the key: a lingering balance that clears and returns pings again', async () => {
    lingeringOnly(4)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpRes(true, 200)))
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetch).toHaveBeenCalledTimes(1)

    // cleared
    mockDelegates([delegateRow(4)])
    mockGetTokenBalance.mockResolvedValue(0n)
    let fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).not.toHaveBeenCalled()

    // returns
    lingeringOnly(4)
    fetchMock = vi.fn().mockResolvedValue(httpRes(true, 200))
    vi.stubGlobal('fetch', fetchMock)
    await runDelegateBalanceMonitor({ info: vi.fn(), warn: vi.fn() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
