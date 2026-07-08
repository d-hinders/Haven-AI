import { describe, expect, it, vi } from 'vitest'
import { Interface, getAddress } from 'ethers'
import { SMART_SESSIONS_ADDRESS } from '@rhinestone/module-sdk'

vi.mock('../db.js', () => ({ default: { query: vi.fn() } }))

const {
  buildScheduledSession,
  buildSessionSchedule,
  buildScheduleFromNow,
  buildScheduleReplacementPayload,
  buildScheduleRevokePayload,
  resolveScheduleRollover,
} = await import('./session-schedule.js')
const { periodIndexAt } = await import('./session-rotation.js')
const { getChain } = await import('./chains.js')
const { getRemoveSessionAction } = await import('./session-policies.js')

const AGENT = '11111111-1111-1111-1111-111111111111'
const POLICY = {
  sessionKeyAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
  usdcAddress: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
  allowedRecipient: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
  budgetAtomic: 100_000n,
  chainId: 84532n,
}
const RESET_MIN = 1440 // daily
const PERIOD_SEC = RESET_MIN * 60
const NOW = 1_900_000_000

describe('buildScheduledSession — the security property', () => {
  it('a future session is DEAD before its window (validAfter = period start)', () => {
    const now = periodIndexAt(NOW, RESET_MIN)
    const future = buildScheduledSession(AGENT, POLICY, RESET_MIN, now + 5)
    // Not usable until 5 periods from now — this is what stops the whole
    // quarter's budget being spendable today.
    expect(future.validAfterSec).toBe((now + 5) * PERIOD_SEC)
    expect(future.validAfterSec).toBeGreaterThan(NOW)
  })

  it('windows overlap by exactly the one-period grace, never more', () => {
    const a = buildScheduledSession(AGENT, POLICY, RESET_MIN, 100)
    const b = buildScheduledSession(AGENT, POLICY, RESET_MIN, 101)
    // a ends at (100+2)*P, b starts at 101*P → overlap = one period (grace).
    expect(a.validUntilSec).toBe(102 * PERIOD_SEC)
    expect(b.validAfterSec).toBe(101 * PERIOD_SEC)
    expect(a.validUntilSec - b.validAfterSec).toBe(PERIOD_SEC)
  })

  it('is deterministic per (agent, period) and distinct across periods/agents', () => {
    expect(buildScheduledSession(AGENT, POLICY, RESET_MIN, 100).permissionId).toBe(
      buildScheduledSession(AGENT, POLICY, RESET_MIN, 100).permissionId,
    )
    expect(buildScheduledSession(AGENT, POLICY, RESET_MIN, 100).permissionId).not.toBe(
      buildScheduledSession(AGENT, POLICY, RESET_MIN, 101).permissionId,
    )
    expect(buildScheduledSession('other', POLICY, RESET_MIN, 100).permissionId).not.toBe(
      buildScheduledSession(AGENT, POLICY, RESET_MIN, 100).permissionId,
    )
  })

  it('budget maps to each period (per-tx cap + cumulative)', () => {
    const initData = buildScheduledSession(AGENT, POLICY, RESET_MIN, 100)
      .session.actions[0].actionPolicies[0].initData.toLowerCase()
    expect(initData).toContain(POLICY.budgetAtomic.toString(16))
  })

  it('rejects a non-positive reset period', () => {
    expect(() => buildScheduledSession(AGENT, POLICY, 0, 1)).toThrow(/positive reset period/)
  })
})

describe('session identity includes the recipient (#805 collision regression)', () => {
  it('two recipients in the SAME period get DIFFERENT permissionIds', () => {
    // Found live by the N×M matrix proof: Smart Sessions derives permissionId
    // from the salt, not the policy content — without the recipient in the
    // salt, both recipients' sessions collapsed to ONE on-chain session and
    // only one policy actually existed.
    const a = buildScheduledSession(AGENT, POLICY, RESET_MIN, 100)
    const b = buildScheduledSession(
      AGENT,
      { ...POLICY, allowedRecipient: ('0x' + 'dd'.repeat(20)) as `0x${string}` },
      RESET_MIN,
      100,
    )
    expect(a.permissionId).not.toBe(b.permissionId)
  })

  it('identity is casing-insensitive on the recipient address', () => {
    const lower = buildScheduledSession(AGENT, POLICY, RESET_MIN, 100)
    const upper = buildScheduledSession(
      AGENT,
      { ...POLICY, allowedRecipient: POLICY.allowedRecipient.toUpperCase().replace('0X', '0x') as `0x${string}` },
      RESET_MIN,
      100,
    )
    expect(upper.permissionId).toBe(lower.permissionId)
  })
})

describe('buildSessionSchedule — ONE signature for many periods', () => {
  it('enables N sessions in a single enableSessions call (no MultiSend)', () => {
    const schedule = buildSessionSchedule(AGENT, POLICY, RESET_MIN, 100, 90)
    expect(schedule.sessions).toHaveLength(90)
    expect(schedule.entries).toHaveLength(90)
    expect(schedule.enablePayload.operation).toBe(0) // plain CALL, not delegatecall
    expect(schedule.enablePayload.to).toBe(getAddress(SMART_SESSIONS_ADDRESS))
    // consecutive, unique
    expect(schedule.entries.map((e) => e.periodIndex)).toEqual(
      Array.from({ length: 90 }, (_, k) => 100 + k),
    )
    expect(new Set(schedule.entries.map((e) => e.permissionId)).size).toBe(90)
  })

  it('buildScheduleFromNow starts at the current period', () => {
    const s = buildScheduleFromNow(AGENT, POLICY, RESET_MIN, NOW, 3)
    expect(s.entries[0].periodIndex).toBe(periodIndexAt(NOW, RESET_MIN))
  })

  it('rejects a non-positive count', () => {
    expect(() => buildSessionSchedule(AGENT, POLICY, RESET_MIN, 100, 0)).toThrow(/positive integer/)
  })
})

describe('buildScheduleReplacementPayload — atomic remove(old) + enable(new)', () => {
  it('with no old sessions is a single enable', () => {
    const next = buildSessionSchedule(AGENT, POLICY, RESET_MIN, 100, 2)
    const payload = buildScheduleReplacementPayload(84532, [], next)
    expect(payload.operation).toBe(0)
    expect(payload.to).toBe(getAddress(SMART_SESSIONS_ADDRESS))
  })

  it('with old sessions is ONE MultiSend: all removes then enable', () => {
    const next = buildSessionSchedule(AGENT, POLICY, RESET_MIN, 105, 2)
    const olds = ['0x' + 'e1'.repeat(32), '0x' + 'e2'.repeat(32)] as `0x${string}`[]
    const payload = buildScheduleReplacementPayload(84532, olds, next)
    expect(payload.operation).toBe(1)
    expect(payload.to).toBe(getAddress(getChain(84532).contracts.multiSendCallOnly))
    // decodes to remove,remove,enable in order
    const iface = new Interface(['function multiSend(bytes transactions) payable'])
    const [transactions] = iface.decodeFunctionData('multiSend', payload.data)
    const r0 = getRemoveSessionAction({ permissionId: olds[0] })
    expect((transactions as string).toLowerCase()).toContain(
      r0.callData.slice(2).toLowerCase().slice(0, 40),
    )
  })
})

describe('buildScheduleRevokePayload — kill switch', () => {
  it('single id = one plain remove; multiple = one MultiSend', () => {
    const one = buildScheduleRevokePayload(84532, ['0x' + 'e1'.repeat(32)] as `0x${string}`[])
    expect(one.operation).toBe(0)
    const many = buildScheduleRevokePayload(
      84532,
      ['0x' + 'e1'.repeat(32), '0x' + 'e2'.repeat(32)] as `0x${string}`[],
    )
    expect(many.operation).toBe(1)
    expect(() => buildScheduleRevokePayload(84532, [])).toThrow(/nothing to revoke/)
  })
})

describe('resolveScheduleRollover — lazy, no signature', () => {
  const schedule = buildSessionSchedule(AGENT, POLICY, RESET_MIN, periodIndexAt(NOW, RESET_MIN), 4)

  it('flags rollover when the recorded id is stale, names the current session', () => {
    const r = resolveScheduleRollover(AGENT, POLICY, RESET_MIN, schedule.entries, '0xstale', NOW)!
    expect(r.currentPeriodIndex).toBe(periodIndexAt(NOW, RESET_MIN))
    expect(r.currentPermissionId).toBe(schedule.entries[0].permissionId)
    expect(r.rolloverDue).toBe(true)
    expect(r.periodsRemaining).toBe(4)
  })

  it('no rollover when the recorded id already matches the current period', () => {
    const r = resolveScheduleRollover(
      AGENT, POLICY, RESET_MIN, schedule.entries, schedule.entries[0].permissionId, NOW,
    )!
    expect(r.rolloverDue).toBe(false)
  })

  it('advances to the next session a period later, WITHOUT any owner action', () => {
    const later = NOW + PERIOD_SEC
    const r = resolveScheduleRollover(AGENT, POLICY, RESET_MIN, schedule.entries, schedule.entries[0].permissionId, later)!
    expect(r.currentPermissionId).toBe(schedule.entries[1].permissionId)
    expect(r.rolloverDue).toBe(true) // recorded is period-0, now period-1
    expect(r.periodsRemaining).toBe(3)
  })

  it('returns null when now is past the enabled schedule (renewal needed)', () => {
    const past = NOW + 10 * PERIOD_SEC
    expect(resolveScheduleRollover(AGENT, POLICY, RESET_MIN, schedule.entries, null, past)).toBeNull()
  })
})
