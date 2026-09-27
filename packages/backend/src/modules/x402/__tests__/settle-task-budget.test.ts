/**
 * #3329 review finding B8: `settle.ts` must pass `state.taskBudgetChild`
 * into `assembleSettlementPayload` — otherwise a task-budget-authorized
 * erc7710 settlement encodes only `[settlement, budget]` at settle time even
 * though the settlement child's `authority` names the task child, and the
 * merchant's redemption of that TWO-link chain reverts (the child's
 * `authority` cannot be matched by the wrong parent in the chain).
 *
 * Direct unit test of `settleX402` — the repositories and the passport
 * lookup are mocked; the settlement compiler (`assembleSettlementPayload`)
 * and the signature recovery run REAL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodeDelegations } from '@metamask/smart-accounts-kit/utils'
import type { Delegation } from '@metamask/smart-accounts-kit'

const { mockFindSettleIntent, mockMarkSubmitted } = vi.hoisted(() => ({
  mockFindSettleIntent: vi.fn(),
  mockMarkSubmitted: vi.fn(),
}))
vi.mock('../../../infra/repositories/x402-authorizations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/x402-authorizations.js')>()
  return {
    ...actual,
    findSettleIntent: (...a: unknown[]) => mockFindSettleIntent(...a),
    markIntentSubmittedForSettlement: (...a: unknown[]) => mockMarkSubmitted(...a),
  }
})
vi.mock('../../passport/index.js', () => ({
  passportReferenceFor: async () => null,
}))

const { settleX402 } = await import('../settle.js')
const { delegationSigningPayload } = await import('../../../rails/delegation-policy.js')
const { serializeUserOp } = await import('../../../rails/execution-rail.js')

const CHAIN_ID = 84532
const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
const DELEGATE_ACCT = DELEGATE_SIGNER.address
const MERCHANT = ('0x' + 'cc'.repeat(20)) as `0x${string}`

const BUDGET: Delegation = {
  delegate: DELEGATE_ACCT,
  delegator: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
  authority: `0x${'ff'.repeat(32)}` as `0x${string}`,
  caveats: [],
  salt: 1n,
  signature: `0x${'ab'.repeat(65)}` as `0x${string}`,
} as unknown as Delegation

const TASK_CHILD: Delegation = {
  delegate: DELEGATE_ACCT,
  delegator: DELEGATE_ACCT, // self-delegated task child
  authority: `0x${'ee'.repeat(32)}` as `0x${string}`,
  caveats: [],
  salt: 2n,
  signature: `0x${'cd'.repeat(65)}` as `0x${string}`,
} as unknown as Delegation

const SETTLEMENT_CHILD: Omit<Delegation, 'signature'> = {
  delegate: '0x0000000000000000000000000000000000000a11',
  delegator: DELEGATE_ACCT,
  authority: `0x${'11'.repeat(32)}` as `0x${string}`,
  caveats: [],
  salt: 3n,
} as unknown as Omit<Delegation, 'signature'>

async function signChild(): Promise<`0x${string}`> {
  const payload = delegationSigningPayload(SETTLEMENT_CHILD, CHAIN_ID)
  return DELEGATE_SIGNER.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as never,
  })
}

const AGENT = {
  id: 'agent-1',
  delegate_address: DELEGATE_ACCT,
} as never

describe('settleX402 threads the task budget child into the encoded chain (#3329 B8)', () => {
  beforeEach(() => {
    mockFindSettleIntent.mockReset()
    mockMarkSubmitted.mockReset()
  })

  it('with a task budget: the X-PAYMENT permission context decodes to THREE links [settlement, taskChild, budget]', async () => {
    const signature = await signChild()
    mockFindSettleIntent.mockResolvedValue({
      id: 'intent-1',
      status: 'pending_signature',
      execution_rail: 'delegation',
      chain_id: CHAIN_ID,
      x402_resource_url: 'https://merchant.example/resource',
      to_address: MERCHANT,
      amount_raw: '100000',
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      machine_metadata: null,
      prepared_user_op: serializeUserOp({
        child: SETTLEMENT_CHILD,
        budget: BUDGET,
        delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532',
        maxTimeoutSeconds: 300,
        taskBudgetChild: TASK_CHILD,
      }),
    })

    const result = await settleX402(AGENT, 'intent-1', signature)
    expect(result.code).toBe(200)
    const body = result.body as { payment_header: string }
    const envelope = JSON.parse(Buffer.from(body.payment_header, 'base64').toString('utf8'))
    const permissionContext = envelope.payload.permissionContext as `0x${string}`
    const decoded = decodeDelegations(permissionContext)
    expect(decoded).toHaveLength(3)
    // leaf-first: settlement child, then the task child, then the budget.
    expect(decoded[1].delegator.toLowerCase()).toBe(TASK_CHILD.delegator.toString().toLowerCase())
    expect(decoded[2].delegator.toLowerCase()).toBe(BUDGET.delegator.toString().toLowerCase())
  })

  it('without a task budget: the permission context decodes to TWO links [settlement, budget], unchanged', async () => {
    const signature = await signChild()
    mockFindSettleIntent.mockResolvedValue({
      id: 'intent-2',
      status: 'pending_signature',
      execution_rail: 'delegation',
      chain_id: CHAIN_ID,
      x402_resource_url: 'https://merchant.example/resource',
      to_address: MERCHANT,
      amount_raw: '100000',
      token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      machine_metadata: null,
      prepared_user_op: serializeUserOp({
        child: SETTLEMENT_CHILD,
        budget: BUDGET,
        delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532',
        maxTimeoutSeconds: 300,
      }),
    })

    const result = await settleX402(AGENT, 'intent-2', signature)
    expect(result.code).toBe(200)
    const body = result.body as { payment_header: string }
    const envelope = JSON.parse(Buffer.from(body.payment_header, 'base64').toString('utf8'))
    const decoded = decodeDelegations(envelope.payload.permissionContext as `0x${string}`)
    expect(decoded).toHaveLength(2)
  })
})

