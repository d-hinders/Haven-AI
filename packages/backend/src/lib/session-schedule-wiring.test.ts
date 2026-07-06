import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const { resolveScheduledAuthorization, commitScheduleRollover } = await import(
  './session-schedule-wiring.js'
)
const { buildSessionSchedule } = await import('./session-schedule.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DELEGATE = '0x' + '11'.repeat(20)
const RECIPIENT = '0x' + 'ab'.repeat(20)
const AGENT = { id: 'agent-1', chain_id: 84532 }
const RESET_MIN = 60 // 1h periods
const PERIOD_SEC = RESET_MIN * 60

const policy = {
  sessionKeyAddress: DELEGATE as `0x${string}`,
  usdcAddress: USDC as `0x${string}`,
  allowedRecipient: RECIPIENT as `0x${string}`,
  budgetAtomic: 5_000_000n,
  chainId: 84532n,
}

/** now = middle of period `p`; the reference schedule covers [100, 103). */
const FROM_PERIOD = 100
const COUNT = 3
const SCHEDULE = buildSessionSchedule(AGENT.id, policy, RESET_MIN, FROM_PERIOD, COUNT)
function nowInPeriod(p: number): number {
  return p * PERIOD_SEC + PERIOD_SEC / 2
}

function windowRow(overrides: Record<string, unknown> = {}) {
  return {
    session_schedule_from_period: FROM_PERIOD,
    session_schedule_period_count: COUNT,
    session_permission_id: SCHEDULE.entries[0].permissionId, // period 100 recorded
    delegate_address: DELEGATE,
    reset_period_min: RESET_MIN,
    ...overrides,
  }
}

function recipientRow(overrides: Record<string, unknown> = {}) {
  return {
    recipient_address: RECIPIENT,
    token_address: USDC,
    label: null,
    budget_amount: '5000000',
    allowance_amount: '5000000',
    ...overrides,
  }
}

/** Pattern-matched DB mock (#775): dispatch on SQL fragment, not call order. */
function mockDb(opts: { window?: Record<string, unknown> | null; recipients?: unknown[] }) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM agent_recipients/.test(sql)) {
      return Promise.resolve({ rows: opts.recipients ?? [recipientRow()] })
    }
    if (/session_schedule_from_period/.test(sql)) {
      return Promise.resolve({ rows: opts.window === null ? [] : [opts.window ?? windowRow()] })
    }
    if (/UPDATE agents/.test(sql)) {
      return Promise.resolve({ rows: [{ id: AGENT.id }] })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => mockQuery.mockReset())

describe('resolveScheduledAuthorization — lazy rollover decision (#769)', () => {
  it('same period as recorded: returns the entry, rollover NOT due', async () => {
    mockDb({})
    const r = await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(100))
    expect(r).not.toBeNull()
    expect(r!.permissionId).toBe(SCHEDULE.entries[0].permissionId)
    expect(r!.rolloverDue).toBe(false)
    expect(r!.periodsRemaining).toBe(3)
  })

  it('period advanced: rollover due, next scheduled permissionId returned — no signature', async () => {
    mockDb({})
    const r = await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(101))
    expect(r!.rolloverDue).toBe(true)
    expect(r!.permissionId).toBe(SCHEDULE.entries[1].permissionId)
    expect(r!.recordedPermissionId).toBe(SCHEDULE.entries[0].permissionId)
    expect(r!.periodsRemaining).toBe(2)
  })

  it('current period past the window: null — renewal needed, fail-closed', async () => {
    mockDb({})
    expect(await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(103))).toBeNull()
  })

  it('no schedule window on the agent: null — #734 single-session behavior', async () => {
    mockDb({ window: windowRow({ session_schedule_from_period: null, session_schedule_period_count: null }) })
    expect(await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(100))).toBeNull()
  })

  it('payment recipient not in agent_recipients: null — schedule does not cover it', async () => {
    mockDb({ recipients: [] })
    expect(await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(100))).toBeNull()
  })

  it('recipient with zero resolved budget: null (fail-closed)', async () => {
    mockDb({ recipients: [recipientRow({ budget_amount: null, allowance_amount: null })] })
    expect(await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(100))).toBeNull()
  })

  it('recipient matching is case-insensitive on the address', async () => {
    mockDb({})
    const r = await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT.toUpperCase().replace('0X', '0x'), nowInPeriod(100))
    expect(r).not.toBeNull()
  })

  it('the decision itself never writes (the flip is a separate, post-prepare commit)', async () => {
    mockDb({})
    await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(101))
    for (const [sql] of mockQuery.mock.calls) {
      expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true)
    }
  })
})

describe('commitScheduleRollover — guarded flip', () => {
  it('updates guarded on the previously recorded id (race-safe)', async () => {
    mockDb({})
    const scheduled = (await resolveScheduledAuthorization(AGENT, USDC, RECIPIENT, nowInPeriod(101)))!
    const flipped = await commitScheduleRollover(AGENT.id, scheduled)
    expect(flipped).toBe(true)
    const update = mockQuery.mock.calls.find(([sql]) => /UPDATE agents/.test(String(sql)))!
    expect(String(update[0])).toContain('IS NOT DISTINCT FROM')
    expect(update[1]).toEqual([scheduled.permissionId, AGENT.id, scheduled.recordedPermissionId])
  })
})
