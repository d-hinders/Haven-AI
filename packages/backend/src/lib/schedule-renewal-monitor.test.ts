import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const {
  computeRenewalNotifications,
  newRenewalNotifyState,
  scanRenewalCandidates,
} = await import('./schedule-renewal-monitor.js')

const RESET_MIN = 60
const PERIOD_SEC = RESET_MIN * 60

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    agentName: 'Payment Agent',
    fromPeriod: 100,
    periodCount: 5, // täcker perioderna 100–104
    resetPeriodMin: RESET_MIN,
    ...overrides,
  }
}

function report(candidates: unknown[]) {
  return { candidates, scannedAt: '' } as never
}

function nowInPeriod(p: number): number {
  return p * PERIOD_SEC + PERIOD_SEC / 2
}

beforeEach(() => mockQuery.mockReset())

describe('computeRenewalNotifications — edge-triggered, max two per window (#803)', () => {
  it('silent while plenty of periods remain', () => {
    const r = computeRenewalNotifications(report([candidate()]), newRenewalNotifyState(), nowInPeriod(100))
    expect(r.messages).toHaveLength(0)
  })

  it('pings ONCE on the transition into renewal_due (≤2 left), then stays silent', () => {
    const state = newRenewalNotifyState()
    const first = computeRenewalNotifications(report([candidate()]), state, nowInPeriod(103)) // 2 kvar
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toContain('2 pre-approved budget periods left')
    const second = computeRenewalNotifications(report([candidate()]), first.nextState, nowInPeriod(103))
    expect(second.messages).toHaveLength(0)
  })

  it('pings once more when the LAST period starts — and never again', () => {
    let state = computeRenewalNotifications(report([candidate()]), newRenewalNotifyState(), nowInPeriod(103)).nextState
    const last = computeRenewalNotifications(report([candidate()]), state, nowInPeriod(104)) // sista
    expect(last.messages).toHaveLength(1)
    expect(last.messages[0]).toContain('LAST pre-approved budget period')
    const after = computeRenewalNotifications(report([candidate()]), last.nextState, nowInPeriod(104))
    expect(after.messages).toHaveLength(0)
  })

  it('a renewed window (new from/count) starts a fresh episode', () => {
    const state = computeRenewalNotifications(report([candidate()]), newRenewalNotifyState(), nowInPeriod(103)).nextState
    const renewed = candidate({ fromPeriod: 104, periodCount: 90 })
    // gott om perioder igen → tyst; och när DEN närmar sig slutet pingar den på nytt
    const quiet = computeRenewalNotifications(report([renewed]), state, nowInPeriod(105))
    expect(quiet.messages).toHaveLength(0)
    const due = computeRenewalNotifications(report([renewed]), quiet.nextState, nowInPeriod(192))
    expect(due.messages).toHaveLength(1)
  })

  it('expired or not-yet-started windows are ignored', () => {
    const r = computeRenewalNotifications(
      report([candidate({ fromPeriod: 100, periodCount: 2 })]), // slut efter period 101
      newRenewalNotifyState(),
      nowInPeriod(105),
    )
    expect(r.messages).toHaveLength(0)
  })

  it('copy is outcome language — no session/permission jargon (#736)', () => {
    const r = computeRenewalNotifications(report([candidate()]), newRenewalNotifyState(), nowInPeriod(104))
    expect(r.messages[0]).not.toMatch(/session|permission/i)
  })
})

describe('scanRenewalCandidates', () => {
  it('selects only active session-rail agents with an enabled window — read-only', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        agent_id: 'agent-1',
        agent_name: 'Payment Agent',
        session_schedule_from_period: 100,
        session_schedule_period_count: 5,
        reset_period_min: 60,
      }],
    })
    const report = await scanRenewalCandidates()
    expect(report.candidates[0]).toMatchObject({ agentId: 'agent-1', fromPeriod: 100 })
    const [sql] = mockQuery.mock.calls[0]
    expect(String(sql)).toContain("us.execution_rail = 'session_key'")
    expect(String(sql)).toContain('session_schedule_from_period IS NOT NULL')
    expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true)
  })
})
