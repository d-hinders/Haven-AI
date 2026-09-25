import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, pad, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  MAX_TASK_BUDGET_TTL_SECONDS,
  isTaskChildTypedData,
  assertOwnTaskChild,
  assertOwnTaskBudgetCloseUserOp,
  hashDelegation,
  type TaskChildExpectation,
} from './task-budget-guards.js'
import { HavenTypedDataRefusedError } from './direct-payment-guard.js'
import { assertOwnSettlementChild } from './direct-payment-guard.js'
import { DELEGATION_MANAGER, CAVEAT_ENFORCERS, ROOT_AUTHORITY } from './settlement-child.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { buildExecuteCallData } from './test-support/direct-userop.js'
import { DELEGATION_TUPLE_COMPONENTS } from './redemption-guard.js'
import { HYBRID_DELEGATOR_DOMAIN_NAME, HYBRID_DELEGATOR_DOMAIN_VERSION, PACKED_USER_OPERATION_FIELDS, ENTRY_POINT_V07, packedUserOperationHash } from './userop-binding.js'

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`
const CHAIN_ID = 84532
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT: Address = '0x98ffBf30459a98FD80fAce18f519967769641F76'
const PARENT_HASH: Hex = `0x${'22'.repeat(32)}`

// Stand-in addresses, properly checksummed (derived from throwaway keys —
// nothing here signs).
const OTHER_ADDRESS = privateKeyToAccount(generatePrivateKey()).address
const FACILITATOR_ADDRESS = privateKeyToAccount(generatePrivateKey()).address
const OTHER_TOKEN_ADDRESS = privateKeyToAccount(generatePrivateKey()).address

function terms20Amount(token: Address, amount: bigint): Hex {
  const amt = amount.toString(16).padStart(64, '0')
  return `0x${token.slice(2).toLowerCase()}${amt}` as Hex
}

function termsTimestamp(before: number): Hex {
  const after = '0'.repeat(32)
  const beforeHex = before.toString(16).padStart(32, '0')
  return `0x${after}${beforeHex}` as Hex
}

function termsAllowedCalldata(recipient: Address): Hex {
  const startIndex = (4).toString(16).padStart(64, '0')
  const padded = pad(recipient, { size: 32 }).slice(2)
  return `0x${startIndex}${padded}` as Hex
}

function buildTaskChildTypedData(opts: {
  ownAccount: Address
  chainId?: number
  delegate?: Address
  delegator?: Address
  authority?: Hex
  token?: Address
  amount?: bigint
  expiresAt?: number
  recipient?: Address | null
  extraCaveat?: { enforcer: Address; terms: Hex }
}) {
  const caveats: Array<{ enforcer: Address; terms: Hex }> = [
    { enforcer: CAVEAT_ENFORCERS.erc20TransferAmount as Address, terms: terms20Amount(opts.token ?? TOKEN, opts.amount ?? 100n) },
    { enforcer: CAVEAT_ENFORCERS.timestamp as Address, terms: termsTimestamp(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) },
  ]
  if (opts.recipient) {
    caveats.push({ enforcer: CAVEAT_ENFORCERS.allowedCalldata as Address, terms: termsAllowedCalldata(opts.recipient) })
  }
  if (opts.extraCaveat) caveats.push(opts.extraCaveat)
  return {
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId: opts.chainId ?? CHAIN_ID,
      verifyingContract: DELEGATION_MANAGER,
    },
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
      delegate: opts.delegate ?? opts.ownAccount,
      delegator: opts.delegator ?? opts.ownAccount,
      authority: opts.authority ?? PARENT_HASH,
      caveats,
      salt: 1n,
    },
  }
}

function defaultExpectation(ownAccount: Address): TaskChildExpectation {
  return {
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    maxAmountAtomic: '100',
    recipientAddress: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    parentDelegationHash: PARENT_HASH,
  }
}

describe('isTaskChildTypedData', () => {
  it('is true for a self-delegated Delegation payload', () => {
    const own = privateKeyToAccount(generatePrivateKey()).address
    const td = buildTaskChildTypedData({ ownAccount: own })
    expect(isTaskChildTypedData(td)).toBe(true)
  })

  it('is false when delegate !== delegator (a settlement child shape)', () => {
    const own = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
    const facilitator = FACILITATOR_ADDRESS
    const td = buildTaskChildTypedData({ ownAccount: own, delegate: facilitator })
    expect(isTaskChildTypedData(td)).toBe(false)
  })

  it('is false for a non-Delegation payload', () => {
    expect(isTaskChildTypedData({ primaryType: 'PackedUserOperation', domain: {}, message: {} })).toBe(false)
  })
})

describe('assertOwnTaskChild', () => {
  const key = generatePrivateKey()
  const delegateAddress = privateKeyToAccount(key).address
  const ownAccount = deriveDelegateAccountAddress(delegateAddress)

  it('accepts a well-formed self-delegated task child', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).not.toThrow()
  })

  it('accepts a recipient-pinned task child matching the expectation', () => {
    const expected = { ...defaultExpectation(ownAccount), recipientAddress: RECIPIENT }
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt, recipient: RECIPIENT })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).not.toThrow()
  })

  it('refuses a non-Delegation payload', () => {
    expect(() =>
      assertOwnTaskChild({ primaryType: 'Bogus', domain: {}, message: {} }, defaultExpectation(ownAccount), delegateAddress),
    ).toThrow(HavenTypedDataRefusedError)
  })

  it('refuses the wrong chain', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, chainId: 1, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/wrong chain/)
  })

  it('refuses a delegator that is not this signer own account', () => {
    const expected = defaultExpectation(ownAccount)
    const other = OTHER_ADDRESS
    const td = buildTaskChildTypedData({ ownAccount, delegator: other, delegate: other, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/own account/)
  })

  it('refuses a delegate that is not self (facilitator-shaped)', () => {
    const expected = defaultExpectation(ownAccount)
    const other = OTHER_ADDRESS
    const td = buildTaskChildTypedData({ ownAccount, delegate: other, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/self-delegated/)
  })

  it('refuses a ROOT authority', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, authority: ROOT_AUTHORITY as Hex, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/ROOT delegation/)
  })

  it('refuses an authority that does not match the parent delegation hash', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, authority: `0x${'33'.repeat(32)}` as Hex, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/different parent delegation/)
  })

  it('refuses a token mismatch', () => {
    const expected = defaultExpectation(ownAccount)
    const otherToken = OTHER_TOKEN_ADDRESS
    const td = buildTaskChildTypedData({ ownAccount, token: otherToken, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/different token/)
  })

  it('refuses an amount mismatch', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, amount: 999n, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/amount does not match/)
  })

  it('refuses an expiry beyond the TTL ceiling', () => {
    const tooFar = Math.floor(Date.now() / 1000) + MAX_TASK_BUDGET_TTL_SECONDS + 3600
    const expected = { ...defaultExpectation(ownAccount), expiresAt: tooFar }
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: tooFar })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/longer than a task budget may live/)
  })

  it('refuses an already-expired child', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const expected = { ...defaultExpectation(ownAccount), expiresAt: past }
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: past })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/already expired/)
  })

  it('refuses a missing recipient pin when one was expected', () => {
    const expected = { ...defaultExpectation(ownAccount), recipientAddress: RECIPIENT }
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/no recipient pin/)
  })

  it('refuses an unexpected recipient pin on an open task budget', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt, recipient: RECIPIENT })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/not opened with/)
  })

  it('refuses a recipient pin that does not match', () => {
    const expected = { ...defaultExpectation(ownAccount), recipientAddress: RECIPIENT }
    const other = OTHER_ADDRESS
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt, recipient: other })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).toThrow(/different recipient/)
  })

  it('accepts an extra AND-ed caveat', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({
      ownAccount,
      expiresAt: expected.expiresAt,
      extraCaveat: { enforcer: '0x1234567890123456789012345678901234567890' as Address, terms: '0x' as Hex },
    })
    expect(() => assertOwnTaskChild(td, expected, delegateAddress)).not.toThrow()
  })
})

describe('assertOwnTaskChild / assertOwnSettlementChild cross-refusal (#3329)', () => {
  const key = generatePrivateKey()
  const delegateAddress = privateKeyToAccount(key).address
  const ownAccount = deriveDelegateAccountAddress(delegateAddress)

  it('a task child is refused by assertOwnSettlementChild', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildTaskChildTypedData({ ownAccount, expiresAt: expected.expiresAt, recipient: RECIPIENT })
    expect(() =>
      assertOwnSettlementChild(
        td,
        { merchantTo: RECIPIENT, amount: '100', asset: TOKEN, chainId: CHAIN_ID },
        delegateAddress,
      ),
    ).toThrow()
  })

  it('a settlement child is refused by assertOwnTaskChild', () => {
    const facilitator = FACILITATOR_ADDRESS
    const settlementChild = buildTaskChildTypedData({
      ownAccount,
      delegate: facilitator,
      recipient: RECIPIENT,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })
    expect(() => assertOwnTaskChild(settlementChild, defaultExpectation(ownAccount), delegateAddress)).toThrow(
      HavenTypedDataRefusedError,
    )
  })
})

// ── assertOwnTaskBudgetCloseUserOp ──────────────────────────────────────────

const DISABLE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'disableDelegation',
    inputs: [{ name: 'delegation', type: 'tuple', components: DELEGATION_TUPLE_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

function buildCloseUserOp(opts: {
  delegateAddress: Address
  chainId?: number
  sender?: Address
  target?: Address
  delegation?: { delegate: Address; delegator: Address; authority: Hex }
}) {
  const sender = opts.sender ?? deriveDelegateAccountAddress(opts.delegateAddress)
  const delegation: {
    delegate: Address
    delegator: Address
    authority: Hex
    caveats: readonly { enforcer: Address; terms: Hex; args: Hex }[]
    salt: bigint
    signature: Hex
  } = {
    delegate: opts.delegation?.delegate ?? sender,
    delegator: opts.delegation?.delegator ?? sender,
    authority: opts.delegation?.authority ?? PARENT_HASH,
    caveats: [],
    salt: 1n,
    signature: `0x${'ab'.repeat(65)}` as Hex,
  }
  const innerCallData = encodeFunctionData({
    abi: DISABLE_DELEGATION_ABI,
    functionName: 'disableDelegation',
    args: [delegation],
  })
  const callData = buildExecuteCallData(opts.target ?? (DELEGATION_MANAGER as Address), 0n, innerCallData)
  const typedData = {
    domain: {
      name: 'HybridDeleGator',
      version: HYBRID_DELEGATOR_DOMAIN_VERSION,
      chainId: opts.chainId ?? CHAIN_ID,
      verifyingContract: sender,
    },
    types: { PackedUserOperation: PACKED_USER_OPERATION_FIELDS.map((f) => ({ ...f })) },
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender,
      nonce: '0',
      initCode: '0x',
      callData,
      accountGasLimits: ZERO_BYTES32,
      preVerificationGas: '0',
      gasFees: ZERO_BYTES32,
      paymasterAndData: '0x',
      entryPoint: ENTRY_POINT_V07,
    },
  }
  return { typedData, delegation, delegationHash: hashDelegation(delegation) }
}

describe('assertOwnTaskBudgetCloseUserOp', () => {
  const key = generatePrivateKey()
  const delegateAddress = privateKeyToAccount(key).address

  it('accepts a well-formed disableDelegation(own self-delegated child) UserOp', () => {
    const { typedData, delegationHash } = buildCloseUserOp({ delegateAddress })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).not.toThrow()
  })

  it('refuses a sender that is not this signer own account', () => {
    const other = OTHER_ADDRESS
    const { typedData, delegationHash } = buildCloseUserOp({ delegateAddress, sender: other })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).toThrow(HavenTypedDataRefusedError)
  })

  it('refuses a target other than the DelegationManager', () => {
    const other = OTHER_ADDRESS
    const { typedData, delegationHash } = buildCloseUserOp({ delegateAddress, target: other })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).toThrow(/DelegationManager/)
  })

  it('refuses a disabled delegation not granted to the own account', () => {
    const sender = deriveDelegateAccountAddress(delegateAddress)
    const other = OTHER_ADDRESS
    const { typedData, delegationHash } = buildCloseUserOp({
      delegateAddress,
      delegation: { delegate: other, delegator: sender, authority: PARENT_HASH },
    })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).toThrow(/granted to/)
  })

  it('refuses a disabled delegation granted by a different account (not self-delegated)', () => {
    const sender = deriveDelegateAccountAddress(delegateAddress)
    const other = OTHER_ADDRESS
    const { typedData, delegationHash } = buildCloseUserOp({
      delegateAddress,
      delegation: { delegate: sender, delegator: other, authority: PARENT_HASH },
    })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).toThrow(/granted by/)
  })

  it('refuses a ROOT authority', () => {
    const sender = deriveDelegateAccountAddress(delegateAddress)
    const { typedData, delegationHash } = buildCloseUserOp({
      delegateAddress,
      delegation: { delegate: sender, delegator: sender, authority: ROOT_AUTHORITY as Hex },
    })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).toThrow(/ROOT delegation/)
  })

  it('refuses a mismatched expected delegation hash', () => {
    const { typedData } = buildCloseUserOp({ delegateAddress })
    expect(() =>
      assertOwnTaskBudgetCloseUserOp(
        typedData as unknown as Record<string, unknown>,
        { delegationHash: `0x${'99'.repeat(32)}` },
        delegateAddress,
      ),
    ).toThrow(/not the task budget's own child/)
  })
})

describe('hashDelegation pin (#3329)', () => {
  it('matches @metamask/smart-accounts-kit/utils hashDelegation for a real delegation shape', async () => {
    const kit = await import('@metamask/smart-accounts-kit/utils')
    const delegation = {
      delegate: OTHER_ADDRESS,
      delegator: FACILITATOR_ADDRESS,
      authority: `0x${'11'.repeat(32)}` as Hex,
      caveats: [
        { enforcer: CAVEAT_ENFORCERS.erc20TransferAmount as Address, terms: terms20Amount(TOKEN, 100n) },
        { enforcer: CAVEAT_ENFORCERS.timestamp as Address, terms: termsTimestamp(1234567890) },
      ],
      salt: 42n,
    }
    const expected = kit.hashDelegation({ ...delegation, signature: '0x' } as never)
    expect(hashDelegation(delegation)).toBe(expected)
  })
})
