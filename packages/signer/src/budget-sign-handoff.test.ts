/**
 * #3506 review S1 — the `haven_submit` handoff `haven_sign` emits after
 * signing a budget row is tied to the DECLARED shape, not just to a literal.
 *
 * `signTaskBudget` / `signSubBudget` in `tools.ts` build `next_arguments` by
 * hand, and `SIGNER_HOSTED_HANDOFF_SHAPES` is what the hosted server's parity
 * test (`next-step-signer-parity.test.ts`) pins to the hosted schemas. Before
 * this test nothing connected the two: renaming the emitted key left every
 * signer test green while the declared (and hosted-checked) shape went stale.
 * Here the REAL emission, driven through the public tool surface against a
 * stubbed sign-context, must parse strictly under the declared entry.
 *
 * Mutation proof (recorded, not committed): renaming `sub_budget_id` to
 * `sub_budget` in `signSubBudget`'s `next_arguments` (tools.ts) turns the
 * sub-budget test red; the same rename of `task_budget_id` in
 * `signTaskBudget` turns the task-budget test red.
 *
 * Purpose `close` drives both: it needs only a bound `disableDelegation`
 * UserOp, and both purposes return through the same `next_arguments` line.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  DELEGATION_MANAGER,
  DELEGATION_TUPLE_COMPONENTS,
  deriveDelegateAccountAddress,
  hashDelegation,
} from '@haven_ai/sdk/edge'
import { buildBoundDirectUserOp, buildExecuteCallData } from '@haven_ai/sdk/test-support'
import { createEdgeSigner } from './core.js'
import { createToolHandlers } from './tools.js'
import { SIGNER_HOSTED_HANDOFF_SHAPES } from './next-step.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_DELEGATE_ADDRESS = privateKeyToAccount(TEST_KEY).address
const OWN_ACCOUNT = deriveDelegateAccountAddress(TEST_DELEGATE_ADDRESS)
const IDENTITY = { apiKey: 'sk_agent_test_3506', apiUrl: 'https://haven.test' }
const CHAIN_ID = 84532
const PARENT_HASH: Hex = `0x${'22'.repeat(32)}`

const DISABLE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'disableDelegation',
    inputs: [{ name: 'delegation', type: 'tuple', components: DELEGATION_TUPLE_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/** A well-formed, BOUND close UserOp: `disableDelegation` of a self-delegated child. */
function closeFixture() {
  const delegation = {
    delegate: OWN_ACCOUNT,
    delegator: OWN_ACCOUNT,
    authority: PARENT_HASH,
    caveats: [] as readonly { enforcer: Address; terms: Hex; args: Hex }[],
    salt: 1n,
    signature: `0x${'ab'.repeat(65)}` as Hex,
  }
  const innerCallData = encodeFunctionData({ abi: DISABLE_DELEGATION_ABI, functionName: 'disableDelegation', args: [delegation] })
  const callData = buildExecuteCallData(DELEGATION_MANAGER as Address, 0n, innerCallData)
  const { typedData, payloadHash } = buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, callData })
  return { typedData, payloadHash, delegationHash: hashDelegation(delegation) }
}

function handlersFor(body: unknown) {
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
  return createToolHandlers(createEdgeSigner(TEST_KEY), {
    signContext: { loadIdentity: async () => IDENTITY, fetchImpl },
  })
}

const expected = (delegationHash: string) => ({ delegate_account: OWN_ACCOUNT, chain_id: CHAIN_ID, delegation_hash: delegationHash })

describe('haven_sign budget handoffs parse under SIGNER_HOSTED_HANDOFF_SHAPES (#3506 S1)', () => {
  it('sub_budget_id: next_arguments parses strictly under haven_submit#sub_budget', async () => {
    const { typedData, payloadHash, delegationHash } = closeFixture()
    const result = await handlersFor({
      sub_budget_id: 'sb_1',
      purpose: 'close',
      sub_budget_sign_context_version: 1,
      typed_data: typedData,
      user_op_hash: payloadHash,
      expected: expected(delegationHash),
    }).haven_sign({ sub_budget_id: 'sb_1' })
    if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result)}`)
    const data = result.data as { signature: string; next_tool_name: string; next_arguments: unknown }
    expect(data.next_tool_name).toBe('haven_submit')
    const shape = SIGNER_HOSTED_HANDOFF_SHAPES['haven_submit#sub_budget']
    expect(z.object(shape).strict().safeParse(data.next_arguments).success).toBe(true)
    expect(data.next_arguments).toEqual({ sub_budget_id: 'sb_1', signature: data.signature })
  })

  it('task_budget_id: next_arguments parses strictly under haven_submit#task_budget', async () => {
    const { typedData, payloadHash, delegationHash } = closeFixture()
    const result = await handlersFor({
      task_budget_id: 'tb_1',
      purpose: 'close',
      task_sign_context_version: 1,
      typed_data: typedData,
      user_op_hash: payloadHash,
      expected: expected(delegationHash),
    }).haven_sign({ task_budget_id: 'tb_1' })
    if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result)}`)
    const data = result.data as { signature: string; next_tool_name: string; next_arguments: unknown }
    expect(data.next_tool_name).toBe('haven_submit')
    const shape = SIGNER_HOSTED_HANDOFF_SHAPES['haven_submit#task_budget']
    expect(z.object(shape).strict().safeParse(data.next_arguments).success).toBe(true)
  })
})
