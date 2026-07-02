import { describe, expect, it, vi } from 'vitest'
import { Interface, getAddress } from 'ethers'
import { SMART_SESSIONS_ADDRESS } from '@rhinestone/module-sdk'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

const {
  buildRotationPayload,
  buildRotationSession,
  isRotationDue,
  periodIndexAt,
  recordRotatedSession,
  rotationSalt,
} = await import('./session-rotation.js')
const { getChain } = await import('./chains.js')
const { encodeMultiSendTransactions } = await import('./safe7579-provisioning.js')
const { getRemoveSessionAction, getEnableSessionsAction } = await import('./session-policies.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const POLICY = {
  sessionKeyAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
  usdcAddress: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
  allowedRecipient: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
  budgetAtomic: 100_000n, // 0.10 USDC per period
  chainId: 84532n,
}
const RESET_MIN = 1440 // daily, like an AllowanceModule reset period
const PERIOD_SEC = RESET_MIN * 60
const NOW = 1_900_000_000

describe('periodIndexAt', () => {
  it('cuts time into fixed reset-period buckets from the epoch', () => {
    expect(periodIndexAt(NOW, RESET_MIN)).toBe(Math.floor(NOW / PERIOD_SEC))
    expect(periodIndexAt(NOW + PERIOD_SEC, RESET_MIN)).toBe(periodIndexAt(NOW, RESET_MIN) + 1)
  })

  it('rejects non-positive periods (reset_period_min = 0 means "no refill")', () => {
    expect(() => periodIndexAt(NOW, 0)).toThrow(/positive reset period/)
  })
})

describe('buildRotationSession — deterministic per (agent, period)', () => {
  it('same agent + same period → identical permissionId; next period → different', () => {
    const a = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)
    const b = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW + 60) // same period
    const c = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW + PERIOD_SEC)
    expect(a.permissionId).toBe(b.permissionId)
    expect(a.permissionId).not.toBe(c.permissionId)
    expect(c.periodIndex).toBe(a.periodIndex + 1)
  })

  it('different agents never share a session in the same period', () => {
    const other = buildRotationSession('22222222-2222-2222-2222-222222222222', POLICY, RESET_MIN, NOW)
    const mine = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)
    expect(other.permissionId).not.toBe(mine.permissionId)
    expect(rotationSalt(AGENT_ID, 1)).not.toBe(rotationSalt(AGENT_ID, 2))
  })

  it('budget maps to the cumulative limit and (by default) the per-tx cap', () => {
    const { session } = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)
    const initData = session.actions[0].actionPolicies[0].initData.toLowerCase()
    expect(initData).toContain(POLICY.budgetAtomic.toString(16)) // usage.limit AND per-tx ref
  })

  it('stays valid one full period past its own (grace for a late owner)', () => {
    const { periodIndex, validUntilSec } = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)
    expect(validUntilSec).toBe((periodIndex + 2) * PERIOD_SEC)
  })
})

describe('isRotationDue — stateless comparison', () => {
  const current = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)

  it('not due while the recorded session matches the current period', () => {
    expect(isRotationDue(AGENT_ID, POLICY, RESET_MIN, current.permissionId, NOW + 60)).toBe(false)
  })

  it('due once the period advances', () => {
    expect(
      isRotationDue(AGENT_ID, POLICY, RESET_MIN, current.permissionId, NOW + PERIOD_SEC),
    ).toBe(true)
  })

  it('due when no session is on record (first rotation)', () => {
    expect(isRotationDue(AGENT_ID, POLICY, RESET_MIN, null, NOW)).toBe(true)
  })
})

describe('buildRotationPayload — atomic remove + enable', () => {
  const next = buildRotationSession(AGENT_ID, POLICY, RESET_MIN, NOW)
  const OLD = ('0x' + 'ee'.repeat(32)) as `0x${string}`

  it('first enable (no predecessor) is a single plain CALL to Smart Sessions', () => {
    const payload = buildRotationPayload(84532, null, next)
    expect(payload.operation).toBe(0)
    expect(payload.to).toBe(getAddress(SMART_SESSIONS_ADDRESS))
    expect(payload.newPermissionId).toBe(next.permissionId)
  })

  it('rotation is ONE MultiSend: remove(old) then enable(new) — no gap, no overlap', () => {
    const payload = buildRotationPayload(84532, OLD, next)
    expect(payload.operation).toBe(1) // delegatecall into MultiSendCallOnly
    expect(payload.to).toBe(getAddress(getChain(84532).contracts.multiSendCallOnly))

    const iface = new Interface(['function multiSend(bytes transactions) payable'])
    const [transactions] = iface.decodeFunctionData('multiSend', payload.data)
    const remove = getRemoveSessionAction({ permissionId: OLD })
    const enable = getEnableSessionsAction({ sessions: [next.session] })
    expect(transactions).toBe(
      encodeMultiSendTransactions([
        { to: getAddress(remove.target), value: 0n, data: remove.callData, operation: 0 },
        { to: getAddress(enable.target), value: 0n, data: enable.callData, operation: 0 },
      ]),
    )
  })
})

describe('recordRotatedSession — guarded switch', () => {
  it('updates only when the previous permissionId still matches (no clobbering)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID }] })
    await expect(recordRotatedSession(AGENT_ID, '0xold', '0xnew')).resolves.toBe(true)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('IS NOT DISTINCT FROM')
    expect(params).toEqual(['0xnew', AGENT_ID, '0xold'])

    mockQuery.mockResolvedValueOnce({ rows: [] }) // raced by a newer rotation
    await expect(recordRotatedSession(AGENT_ID, '0xstale', '0xnew2')).resolves.toBe(false)
  })
})
