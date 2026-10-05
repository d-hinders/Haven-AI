// The task- and sub-budget CLOSE sign contexts must be JSON-serializable.
//
// Found in epic #3328's dev verification (2026-09-30): `GET
// /task-budgets/:id/sign-context` answered 500 on every close — "Do not know
// how to serialize a BigInt" — because the builder returned the deserialized
// `prepared_user_op` (real bigints) as `user_operation`. The sub-budget
// builder is a copy of the same shape and carried the same defect. Nothing
// tested the close branch of either builder, so both shipped.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeUserOp } from '../../../rails/execution-rail.js'

const DELEGATE_ACCOUNT = '0x1111111111111111111111111111111111111111'

vi.mock('../../../rails/hybrid-provisioning.js', () => ({
  computeHybridAccountAddress: vi.fn(async () => DELEGATE_ACCOUNT),
}))
vi.mock('../../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: vi.fn(),
}))

const { buildTaskBudgetSignContext } = await import('../task-budget-service.js')
const { buildSubBudgetSignContext } = await import('../../sub-budgets/sub-budget-service.js')

/** A prepared v0.7 UserOperation as the rail stores it: bigints, marker-serialized. */
function storedUserOp(): string {
  return serializeUserOp({
    sender: DELEGATE_ACCOUNT,
    nonce: 7n,
    callData: '0xdeadbeef',
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    paymaster: '0x2222222222222222222222222222222222222222',
    paymasterVerificationGasLimit: 30_000n,
    paymasterPostOpGasLimit: 10_000n,
    paymasterData: '0x',
    signature: '0x',
  })
}

const agent = { chain_id: 84532, delegate_address: '0x3333333333333333333333333333333333333333' }

describe('close sign contexts serialize to JSON (#3328 verification)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('task budget: a closing row yields a context JSON.stringify accepts, bigints as "Nn"', async () => {
    const ctx = await buildTaskBudgetSignContext(agent, {
      status: 'closing',
      prepared_user_op: storedUserOp(),
      delegation_hash: '0x' + 'ab'.repeat(32),
    } as never)
    expect(ctx?.purpose).toBe('close')
    const wire = JSON.parse(JSON.stringify(ctx))
    expect(wire.user_operation.nonce).toBe('7n')
    expect(wire.user_operation.callGasLimit).toBe('100000n')
    expect(wire.user_op_hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('sub-budget: a closing row yields a context JSON.stringify accepts, bigints as "Nn"', async () => {
    const ctx = await buildSubBudgetSignContext(agent, {
      status: 'closing',
      prepared_user_op: storedUserOp(),
      delegation_hash: '0x' + 'cd'.repeat(32),
    } as never)
    expect(ctx?.purpose).toBe('close')
    const wire = JSON.parse(JSON.stringify(ctx))
    expect(wire.user_operation.nonce).toBe('7n')
    expect(wire.user_op_hash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
