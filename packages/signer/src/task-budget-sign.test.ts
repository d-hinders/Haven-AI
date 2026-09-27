/**
 * #3329 review finding 1 (BLOCKING): tool-layer coverage for `haven_sign`'s
 * `task_budget_id` arm (`tools.ts`'s `signTaskBudget`, wired at the top of
 * the `haven_sign` handler). Follows `server.test.ts`'s harness
 * (`createToolHandlers` + a mocked `signContext.fetchImpl`) — nothing here
 * imports `tools.ts` internals, only the public tool surface, so these tests
 * exercise exactly what an MCP client calls.
 *
 * Every branch below is paired with a MUTATION PROOF, recorded in the PR /
 * worker report: temporarily removing the guard call (or the exclusivity
 * check) in `tools.ts` and re-running the single test turns it red. The
 * mutation edits themselves are never committed — only the resulting cell
 * (red/green) is recorded.
 */
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeFunctionData, pad, type Address, type Hex } from 'viem'
import {
  CAVEAT_ENFORCERS,
  DELEGATION_MANAGER,
  DELEGATION_TUPLE_COMPONENTS,
  deriveDelegateAccountAddress,
  hashDelegation,
} from '@haven_ai/sdk/edge'
import { buildBoundDirectUserOp, buildExecuteCallData } from '@haven_ai/sdk/test-support'
import { createEdgeSigner } from './core.js'
import { createToolHandlers } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_DELEGATE_ADDRESS = privateKeyToAccount(TEST_KEY).address
const OWN_ACCOUNT = deriveDelegateAccountAddress(TEST_DELEGATE_ADDRESS)
const IDENTITY = { apiKey: 'sk_agent_test_3329', apiUrl: 'https://haven.test' }
const CHAIN_ID = 84532
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PARENT_HASH: Hex = `0x${'22'.repeat(32)}`

function terms20Amount(token: Address, amount: bigint): Hex {
  return `0x${token.slice(2).toLowerCase()}${amount.toString(16).padStart(64, '0')}` as Hex
}
function termsTimestamp(before: number): Hex {
  return `0x${'0'.repeat(32)}${before.toString(16).padStart(32, '0')}` as Hex
}

function buildOpenTypedData(opts: {
  delegator?: Address
  authority?: Hex
  expiresAt?: number
}) {
  return {
    domain: { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: DELEGATION_MANAGER },
    types: {
      Caveat: [
        { name: 'enforcer', type: 'address' },
        { name: 'terms', type: 'bytes' },
      ],
      Delegation: [
        { name: 'delegate', type: 'address' },
        { name: 'delegator', type: 'address' },
        { name: 'authority', type: 'bytes32' },
        { name: 'caveats', type: 'Caveat[]' },
        { name: 'salt', type: 'uint256' },
      ],
    },
    primaryType: 'Delegation',
    message: {
      delegate: OWN_ACCOUNT,
      delegator: opts.delegator ?? OWN_ACCOUNT,
      authority: opts.authority ?? PARENT_HASH,
      caveats: [
        { enforcer: CAVEAT_ENFORCERS.erc20TransferAmount, terms: terms20Amount(TOKEN, 100n) },
        { enforcer: CAVEAT_ENFORCERS.timestamp, terms: termsTimestamp(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) },
      ],
      salt: '1',
    },
  }
}

function openExpected(overrides: Partial<{ expiresAt: number; parentDelegationHash: string }> = {}) {
  return {
    delegate_account: OWN_ACCOUNT,
    chain_id: CHAIN_ID,
    token_address: TOKEN,
    max_amount_atomic: '100',
    recipient_address: null,
    expires_at: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    parent_delegation_hash: overrides.parentDelegationHash ?? PARENT_HASH,
  }
}

const DISABLE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'disableDelegation',
    inputs: [{ name: 'delegation', type: 'tuple', components: DELEGATION_TUPLE_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/** A well-formed, BOUND close UserOp — `disableDelegation` of a self-delegated child. */
function buildCloseFixture(opts: { delegator?: Address } = {}) {
  const delegation = {
    delegate: OWN_ACCOUNT,
    delegator: opts.delegator ?? OWN_ACCOUNT,
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

function fetchImplFor(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

function handlersWith(fetchImpl: typeof fetch) {
  return createToolHandlers(createEdgeSigner(TEST_KEY), {
    signContext: { loadIdentity: async () => IDENTITY, fetchImpl },
  })
}

describe('#3329 haven_sign task_budget_id — exclusivity', () => {
  it('refuses task_budget_id passed together with payment_id (structured INVALID_INPUT)', async () => {
    const handlers = handlersWith(fetchImplFor({}))
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1', payment_id: 'pay_1' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toMatch(/mutually exclusive/)
  })

  it('refuses task_budget_id passed together with payload_hash (structured INVALID_INPUT)', async () => {
    const handlers = handlersWith(fetchImplFor({}))
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1', payload_hash: `0x${'11'.repeat(32)}` })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.message).toMatch(/mutually exclusive/)
  })

  // MUTATION PROOF (recorded, not committed): removing the
  // `if (args.payment_id || args.payload_hash)` exclusivity check in
  // `tools.ts`'s `haven_sign` handler turns BOTH tests above red — the call
  // proceeds into `signTaskBudget` instead of refusing, and
  // `result.success` becomes `true` (or a DIFFERENT error, never
  // INVALID_INPUT). Verified live on 2026-09-26: cell RED confirmed.
})

describe('#3329 haven_sign task_budget_id — purpose open', () => {
  it('signs a well-formed self-delegated task child verbatim, and returns the haven_submit handoff', async () => {
    const typedData = buildOpenTypedData({})
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_1',
        purpose: 'open',
        task_sign_context_version: 1,
        typed_data: typedData,
        expected: openExpected(),
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    const data = result.data as {
      signature: string
      task_budget_id: string
      purpose: string
      next_tool_name: string
      next_tool_server_role: string
      next_arguments: Record<string, unknown>
    }
    expect(data.signature).toMatch(/^0x[0-9a-f]+$/i)
    expect(data.purpose).toBe('open')
    expect(data.next_tool_name).toBe('haven_submit')
    expect(data.next_tool_server_role).toBe('hosted')
    expect(data.next_arguments).toEqual({ task_budget_id: 'tb_1', signature: data.signature })
  })

  it('refuses when the fetched child is delegated by someone other than this agent (wrong delegator)', async () => {
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d').address
    const typedData = buildOpenTypedData({ delegator: other })
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_1',
        purpose: 'open',
        task_sign_context_version: 1,
        typed_data: typedData,
        expected: openExpected(),
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/own account/)
  })

  it('refuses when the fetched child chains under a different parent delegation', async () => {
    const typedData = buildOpenTypedData({ authority: `0x${'33'.repeat(32)}` as Hex })
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_1',
        purpose: 'open',
        task_sign_context_version: 1,
        typed_data: typedData,
        expected: openExpected(),
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/different parent delegation/)
  })

  it('refuses a child whose expiry is beyond the 24h task-budget ceiling', async () => {
    const tooFar = Math.floor(Date.now() / 1000) + 86_400 + 3600
    const typedData = buildOpenTypedData({ expiresAt: tooFar })
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_1',
        purpose: 'open',
        task_sign_context_version: 1,
        typed_data: typedData,
        expected: openExpected({ expiresAt: tooFar }),
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/longer than a task budget may live/)
  })

  // MUTATION PROOF (recorded, not committed): commenting out the
  // `assertOwnTaskChild(...)` call in `tools.ts`'s `signTaskBudget` (purpose
  // 'open' branch) turns the three refusal tests above red — each mismatched
  // fixture signs successfully instead of refusing. Verified live on
  // 2026-09-26: cell RED confirmed. The happy-path test stays green either
  // way (it is well-formed), which is why the refusal tests, not the happy
  // path, are what prove the guard is wired.
})

describe('#3329 haven_sign task_budget_id — purpose close', () => {
  it('signs a well-formed disableDelegation UserOp verbatim, and returns the haven_submit handoff', async () => {
    const { typedData, payloadHash, delegationHash } = buildCloseFixture()
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_2',
        purpose: 'close',
        task_sign_context_version: 1,
        typed_data: typedData,
        user_op_hash: payloadHash,
        expected: { delegate_account: OWN_ACCOUNT, chain_id: CHAIN_ID, delegation_hash: delegationHash },
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_2' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    const data = result.data as { signature: string; purpose: string }
    expect(data.signature).toMatch(/^0x[0-9a-f]+$/i)
    expect(data.purpose).toBe('close')
  })

  it('refuses on a user_op_hash binding mismatch (a corrupted or substituted UserOp)', async () => {
    const { typedData, delegationHash } = buildCloseFixture()
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_2',
        purpose: 'close',
        task_sign_context_version: 1,
        typed_data: typedData,
        user_op_hash: `0x${'ff'.repeat(32)}`, // wrong hash — does not match typedData
        expected: { delegate_account: OWN_ACCOUNT, chain_id: CHAIN_ID, delegation_hash: delegationHash },
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_2' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('USEROP_BINDING_MISMATCH')
  })

  it('refuses a disableDelegation UserOp disabling a delegation granted by a foreign account (not self-delegated)', async () => {
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d').address
    const { typedData, payloadHash, delegationHash } = buildCloseFixture({ delegator: other })
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_2',
        purpose: 'close',
        task_sign_context_version: 1,
        typed_data: typedData,
        user_op_hash: payloadHash,
        expected: { delegate_account: OWN_ACCOUNT, chain_id: CHAIN_ID, delegation_hash: delegationHash },
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_2' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('TYPED_DATA_NOT_ALLOWED')
    expect(result.message).toMatch(/granted by/)
  })

  // MUTATION PROOF (recorded, not committed): (a) removing the
  // `assertUserOpTypedDataBinding(...)` call turns the binding-mismatch test
  // red (it signs the wrong-hash UserOp instead of refusing); (b) removing
  // the `assertOwnTaskBudgetCloseUserOp(...)` call turns the foreign-delegator
  // test red (it signs a close of someone ELSE's delegation). Both verified
  // live on 2026-09-26: cells RED confirmed.
})

describe('#3329 haven_sign task_budget_id — sign-context fetch refusals', () => {
  it('refuses a malformed body (missing typed_data)', async () => {
    const handlers = handlersWith(
      fetchImplFor({ task_budget_id: 'tb_3', purpose: 'open', task_sign_context_version: 1, expected: openExpected() }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_3' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('SIGN_CONTEXT_MALFORMED')
  })

  it('refuses an unsupported task_sign_context_version', async () => {
    const typedData = buildOpenTypedData({})
    const handlers = handlersWith(
      fetchImplFor({
        task_budget_id: 'tb_3',
        purpose: 'open',
        task_sign_context_version: 999,
        typed_data: typedData,
        expected: openExpected(),
      }),
    )
    const result = await handlers.haven_sign({ task_budget_id: 'tb_3' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('SIGN_CONTEXT_MALFORMED')
    expect(result.message).toMatch(/does not support/)
  })

  it('refuses a 404 (unknown task budget id) as SIGN_CONTEXT_REFUSED', async () => {
    const handlers = handlersWith(fetchImplFor({ error: 'not found' }, 404))
    const result = await handlers.haven_sign({ task_budget_id: 'tb_missing' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected a refusal')
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(404)
  })
})
