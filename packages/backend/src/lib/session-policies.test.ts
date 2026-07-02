import { describe, expect, it } from 'vitest'
import { SMART_SESSIONS_ADDRESS, OWNABLE_VALIDATOR_ADDRESS } from '@rhinestone/module-sdk'
import {
  USDC_TRANSFER_SELECTOR,
  buildHavenPolicySession,
  getEnableSessionsAction,
  getPermissionId,
  getRemoveSessionAction,
} from './session-policies.js'

const ARGS = {
  sessionKeyAddress: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
  usdcAddress: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
  allowedRecipient: ('0x' + 'cc'.repeat(20)) as `0x${string}`,
  perTxCapAtomic: 50_000n,
  cumulativeLimitAtomic: 100_000n,
  validUntilSec: 1_800_000_000,
  salt: ('0x' + '01'.repeat(32)) as `0x${string}`,
  chainId: 84532n,
}

describe('buildHavenPolicySession', () => {
  const session = buildHavenPolicySession(ARGS)

  it('binds the session key via the ownable validator (threshold 1)', () => {
    expect(session.sessionValidator).toBe(OWNABLE_VALIDATOR_ADDRESS)
    expect(session.sessionValidatorInitData.toLowerCase()).toContain('aa'.repeat(20))
  })

  it('scopes exactly one action: USDC.transfer', () => {
    expect(USDC_TRANSFER_SELECTOR).toBe('0xa9059cbb')
    expect(session.actions).toHaveLength(1)
    expect(session.actions[0].actionTarget).toBe(ARGS.usdcAddress)
    expect(session.actions[0].actionTargetSelector).toBe('0xa9059cbb')
    expect(session.actions[0].actionPolicies).toHaveLength(1)
  })

  it('embeds recipient + amount rules in the action policy initData', () => {
    const initData = session.actions[0].actionPolicies[0].initData.toLowerCase()
    expect(initData).toContain('cc'.repeat(20)) // allowlisted recipient ref
    expect(initData).toContain(ARGS.perTxCapAtomic.toString(16)) // per-tx cap ref
    expect(initData).toContain(ARGS.cumulativeLimitAtomic.toString(16)) // usage limit
  })

  it('applies expiry as a userOp policy and permits the paymaster', () => {
    expect(session.userOpPolicies).toHaveLength(1)
    expect(session.permitERC4337Paymaster).toBe(true)
    expect(session.chainId).toBe(84532n)
  })

  it('yields a stable permissionId, distinct per salt', () => {
    const a = getPermissionId({ session })
    const b = getPermissionId({ session: buildHavenPolicySession(ARGS) })
    const c = getPermissionId({
      session: buildHavenPolicySession({ ...ARGS, salt: ('0x' + '02'.repeat(32)) as `0x${string}` }),
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('enable/remove actions target the Smart Sessions module', () => {
    const enable = getEnableSessionsAction({ sessions: [session] })
    const remove = getRemoveSessionAction({ permissionId: getPermissionId({ session }) })
    expect(enable.target).toBe(SMART_SESSIONS_ADDRESS)
    expect(remove.target).toBe(SMART_SESSIONS_ADDRESS)
    expect(enable.callData.length).toBeGreaterThan(10)
  })
})
