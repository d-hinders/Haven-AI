/**
 * #3281 (epic #3284) criterion 7 — the x402 EIP-3009 funding leg the backend
 * emits is the ONE shape an updated edge signer will sign.
 *
 * Since #3281 the signer's x402 arm refuses any funding-leg UserOp that is
 * not: this key's own account, a pinned chain, a single `execute` →
 * DelegationManager → `redeemDelegations` of exactly one delegation granted
 * by another account, whose single execution is `transfer(<delegate EOA>,
 * <quoted amount>)` on the quoted token. A future backend change to that
 * shape (a batch call, an ERC-7579 execute, a second execution, a different
 * recipient) would be SILENTLY refused by every updated signer — this test is
 * what turns that into a red build here instead.
 *
 * It drives the production encoders offline: `buildRedemptionCall` (the call
 * `prepareRedemption` sends, extracted for this test), the MetaMask kit's own
 * `encodeCallsForCaller` (what the account's `encodeCalls` does), and
 * `userOpTypedData` (what the agent is asked to sign). Only gas fields and
 * the nonce are stand-ins — the guard does not read them.
 */
import { describe, expect, it } from 'vitest'
import { getUserOperationHash, entryPoint07Address } from 'viem/account-abstraction'
import type { Address, Hex } from 'viem'
import { encodeCallsForCaller } from '@metamask/smart-accounts-kit/utils'
import {
  assertBoundDirectPaymentUserOp,
  assertFundingLegPaysDelegate,
  assertRedeemsOwnBudgetDelegation,
  assertUserOpTypedDataBinding,
  deriveDelegateAccountAddress,
  HavenTypedDataRefusedError,
} from '@haven_ai/sdk/edge'
import { decodeFunctionData, parseAbi } from 'viem'
import { buildRedemptionCall, userOpTypedData, type Delegation } from '../delegation-rail.js'

const EXECUTE_ABI = parseAbi(['function execute((address,uint256,bytes))'])

const CHAIN_ID = 84532
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DELEGATE_EOA: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const ACCOUNT = deriveDelegateAccountAddress(DELEGATE_EOA)
const TREASURY: Address = '0x98ffBf30459a98FD80fAce18f519967769641F76'
const AMOUNT = 1_000_000n

/** A budget delegation granted to the agent's account — the fields the guard reads are real-shaped. */
const BUDGET: Delegation = {
  delegate: ACCOUNT,
  delegator: TREASURY,
  authority: `0x${'ff'.repeat(32)}` as Hex,
  caveats: [
    { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069', terms: `0x${'00'.repeat(32)}` as Hex, args: '0x' as Hex },
  ],
  salt: 1n,
  signature: `0x${'ab'.repeat(65)}` as Hex,
} as unknown as Delegation

/** A task-budget child (#3329): self-delegated by the agent's own account. */
const TASK_CHILD: Delegation = {
  delegate: ACCOUNT,
  delegator: ACCOUNT,
  authority: `0x${'ee'.repeat(32)}` as Hex,
  caveats: [
    { enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069', terms: `0x${'00'.repeat(32)}` as Hex, args: '0x' as Hex },
  ],
  salt: 2n,
  signature: `0x${'cd'.repeat(65)}` as Hex,
} as unknown as Delegation

async function fundingLeg(to: Address = DELEGATE_EOA, delegations: Delegation[] = [BUDGET]) {
  const call = buildRedemptionCall(CHAIN_ID, delegations, USDC, to, AMOUNT)
  const callData = await encodeCallsForCaller(ACCOUNT, [call])
  const userOperation = {
    sender: ACCOUNT,
    nonce: 7n,
    callData,
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    signature: '0x' as Hex,
  }
  const typedData = userOpTypedData(userOperation, ACCOUNT, CHAIN_ID)
  const userOpHash = getUserOperationHash({
    chainId: CHAIN_ID,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: '0.7',
    userOperation,
  })
  return { typedData, userOpHash, callData }
}

describe('funding leg ↔ edge-signer guard contract (#3281)', () => {
  it("the backend's funding leg passes every check the updated signer runs", async () => {
    const { typedData, userOpHash } = await fundingLeg()
    expect(() => assertUserOpTypedDataBinding(typedData, userOpHash)).not.toThrow()
    expect(() => assertBoundDirectPaymentUserOp(typedData, DELEGATE_EOA)).not.toThrow()
    expect(() =>
      assertFundingLegPaysDelegate(typedData, { delegateAddress: DELEGATE_EOA, asset: USDC, amount: AMOUNT.toString() }),
    ).not.toThrow()
  })

  it('positive control: the same builder aimed at another recipient is refused by the guard', async () => {
    // Proves the assertion above can fail: the guard reads THESE bytes.
    const { typedData } = await fundingLeg('0x000000000000000000000000000000000000bad1')
    expect(() =>
      assertFundingLegPaysDelegate(typedData, { delegateAddress: DELEGATE_EOA, asset: USDC, amount: AMOUNT.toString() }),
    ).toThrow(HavenTypedDataRefusedError)
  })

  /**
   * #3329 §4: a task-budget-authorized redemption's chain is `[taskChild,
   * budget]` — TWO delegations, leaf first. `assertRedeemsOwnBudgetDelegation`
   * currently accepts a chain of length 1 only; the contract (worker B) is
   * to extend it to accept length 2 where the leaf is self-delegated (own
   * account both `delegate` and `delegator`) and the root is granted BY
   * someone else. This test is written against that extended contract —
   * it is expected to be RED until that SDK change lands, and this backend
   * slice reports that explicitly rather than weakening the assertion.
   */
  it('[task, budget] chain: the SDK guard accepts a self-delegated leaf over a granted root (#3329)', async () => {
    const { callData } = await fundingLeg(DELEGATE_EOA, [TASK_CHILD, BUDGET])
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: callData })
    const [, , redeemCalldata] = args[0] as [Address, bigint, Hex]
    expect(() => assertRedeemsOwnBudgetDelegation(redeemCalldata, ACCOUNT)).not.toThrow()
  })
})
