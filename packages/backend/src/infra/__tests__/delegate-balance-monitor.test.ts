import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const { mockQuery, mockGetTokenBalance } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetTokenBalance: vi.fn(),
}))

vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../rails/allowance-module.js', () => ({
  getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
}))

const {
  classifyDelegateBalance,
  computeAlerts,
  newAlertState,
  runDelegateBalanceMonitor,
  scanDelegateBalances,
  sweepFloorAtomic,
} = await import('../delegate-balance-monitor.js')

const FLOOR = ethers.parseUnits('0.01', 6) // config default sweepMinUsdc='0.01'

function delegateRow(n: number, chainId = 8453) {
  return {
    agent_id: `agent-${n}`,
    agent_name: `Agent ${n}`,
    delegate_address: `0x${String(n).repeat(2).padStart(2, '0')}${'ab'.repeat(19)}`,
    chain_id: chainId,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockGetTokenBalance.mockReset()
  delete process.env.DELEGATE_DUST_ALERT_USDC
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
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toContain('Lingering')
    // same finding next scan → no new message
    const second = computeAlerts(r, first.nextState)
    expect(second.messages).toHaveLength(0)
  })

  it('re-pings after the balance clears and returns', () => {
    const r = report({ lingering: [lingeringFinding(1)] })
    const s1 = computeAlerts(r, newAlertState()).nextState
    // cleared
    const cleared = computeAlerts(report({ lingering: [] }), s1)
    expect(cleared.messages).toHaveLength(0)
    // returns → pings again
    const back = computeAlerts(r, cleared.nextState)
    expect(back.messages).toHaveLength(1)
  })

  it('pings the dust breach only on the below→above crossing', () => {
    const breach = report({ dustAlert: true, dustTotalAtomic: ethers.parseUnits('30', 6) })
    const cross = computeAlerts(breach, newAlertState())
    expect(cross.messages.some((m: string) => m.includes('dust'))).toBe(true)
    // still above → no repeat
    const stay = computeAlerts(breach, cross.nextState)
    expect(stay.messages).toHaveLength(0)
  })

  it('pings each distinct lingering delegate, dedupes on agent+chain', () => {
    const r = report({ lingering: [lingeringFinding(1), lingeringFinding(2)] })
    expect(computeAlerts(r, newAlertState()).messages).toHaveLength(2)
  })
})
