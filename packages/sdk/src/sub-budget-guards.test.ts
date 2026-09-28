/**
 * #3330 — tests for the sub-budget child guards (`sub-budget-guards.ts`),
 * mirroring `task-budget-guards.test.ts`'s discipline for the two-row
 * sub-budget tree:
 *
 *  - the PARENT-CHILD shape (delegate === delegator === own account) and the
 *    GRANT shape (delegator own, delegate = B's account) are both accepted;
 *  - every disagreement with the sign-context expectation refuses;
 *  - the amount caveat MUST be the period enforcer (a hard-cap caveat is the
 *    task-budget shape and is refused on this channel);
 *  - the period caveat decode matches the KIT'S OWN tight-packed
 *    `abi.encodePacked(address,uint256,uint256,uint256)` terms — proven by
 *    building a real child with `createDelegation` and running the guard
 *    over it (any future kit layout drift fails here, both directions).
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, pad, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createDelegation, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { hashDelegation as kitHashDelegation } from '@metamask/smart-accounts-kit/utils'
import {
  assertOwnSubBudgetChild,
  assertOwnSubBudgetCloseUserOp,
  hashSubBudgetDelegation,
  ERC20_PERIOD_TRANSFER_ENFORCER,
  type SubBudgetChildExpectation,
} from './sub-budget-guards.js'
import { HavenTypedDataRefusedError } from './direct-payment-guard.js'
import { DELEGATION_MANAGER, CAVEAT_ENFORCERS, ROOT_AUTHORITY } from './settlement-child.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { DELEGATION_TUPLE_COMPONENTS } from './redemption-guard.js'
import {
  HYBRID_DELEGATOR_DOMAIN_NAME,
  HYBRID_DELEGATOR_DOMAIN_VERSION,
  PACKED_USER_OPERATION_FIELDS,
  ENTRY_POINT_V07,
} from './userop-binding.js'
import { buildExecuteCallData } from './test-support/direct-userop.js'

const ZERO_BYTES32: Hex = `0x${'00'.repeat(32)}`
const CHAIN_ID = 84532
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT: Address = '0x98ffBf30459a98FD80fAce18f519967769641F76'
const PARENT_HASH: Hex = `0x${'22'.repeat(32)}`

const OTHER_ADDRESS = privateKeyToAccount(generatePrivateKey()).address

/** The kit's TIGHT-packed ERC20PeriodTransferEnforcer terms: 20 + 32×3 bytes. */
function termsPeriod(token: Address, amount: bigint, duration: number, startDate: number): Hex {
  const w = (n: bigint) => n.toString(16).padStart(64, '0')
  return `0x${token.slice(2).toLowerCase()}${w(amount)}${w(BigInt(duration))}${w(BigInt(startDate))}` as Hex
}

function termsTimestamp(before: number): Hex {
  return `0x${'0'.repeat(32)}${before.toString(16).padStart(32, '0')}` as Hex
}

function termsAllowedCalldata(recipient: Address): Hex {
  return `0x${(4).toString(16).padStart(64, '0')}${pad(recipient, { size: 32 }).slice(2)}` as Hex
}

function buildSubBudgetChildTypedData(opts: {
  ownAccount: Address
  chainId?: number
  delegate?: Address
  authority?: Hex
  token?: Address
  periodAmount?: bigint
  periodDuration?: number
  startDate?: number
  expiresAt?: number
  recipient?: Address | null
  omitPeriod?: boolean
  omitTimestamp?: boolean
  extraCaveat?: { enforcer: Address; terms: Hex }
}) {
  const caveats: Array<{ enforcer: Address; terms: Hex }> = []
  if (!opts.omitPeriod) {
    caveats.push({
      enforcer: ERC20_PERIOD_TRANSFER_ENFORCER as Address,
      terms: termsPeriod(opts.token ?? TOKEN, opts.periodAmount ?? 100n, opts.periodDuration ?? 86_400, opts.startDate ?? 1_700_000_000),
    })
  }
  if (!opts.omitTimestamp) {
    caveats.push({ enforcer: CAVEAT_ENFORCERS.timestamp as Address, terms: termsTimestamp(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) })
  }
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
    primaryType: 'Delegation' as const,
    message: {
      delegate: opts.delegate ?? opts.ownAccount,
      delegator: opts.ownAccount,
      authority: opts.authority ?? PARENT_HASH,
      caveats: caveats.map((c) => ({ ...c, args: '0x' as Hex })),
      salt: '0',
    },
  }
}

function defaultExpectation(ownAccount: Address, childDelegate: Address = ownAccount): SubBudgetChildExpectation {
  return {
    chainId: CHAIN_ID,
    tokenAddress: TOKEN,
    periodAmountAtomic: '100',
    periodDurationSeconds: 86_400,
    startDate: 1_700_000_000,
    recipientAddress: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    parentDelegationHash: PARENT_HASH,
    delegateAccount: ownAccount,
    childDelegateAccount: childDelegate,
  }
}

describe('assertOwnSubBudgetChild', () => {
  const key = generatePrivateKey()
  const delegateAddress = privateKeyToAccount(key).address
  const ownAccount = deriveDelegateAccountAddress(delegateAddress)

  it('accepts a well-formed SELF-delegated parent-child (A narrowing its own budget)', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).not.toThrow()
  })

  it('accepts a well-formed GRANT to another agent (delegator own, delegate = B)', () => {
    const expected = defaultExpectation(ownAccount, OTHER_ADDRESS)
    const td = buildSubBudgetChildTypedData({ ownAccount, delegate: OTHER_ADDRESS, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).not.toThrow()
  })

  it('refuses a non-Delegation payload', () => {
    expect(() =>
      assertOwnSubBudgetChild({ primaryType: 'Bogus', domain: {}, message: {} }, defaultExpectation(ownAccount), delegateAddress),
    ).toThrow(HavenTypedDataRefusedError)
  })

  it('refuses an unknown DelegationManager domain contract', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    td.domain.verifyingContract = OTHER_ADDRESS
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/unknown DelegationManager/)
  })

  it('refuses a domain name/version that does not match the pinned DelegationManager domain', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    td.domain.name = 'NotDelegationManager'
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/domain name\/version/)
  })

  it('refuses a chain with no pinned delegation contracts', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, chainId: 1, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/no pinned contracts/)
  })

  it('refuses a pinned chain that still disagrees with what Haven declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, chainId: 8453, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/wrong chain/)
  })

  it('refuses a child not delegated by this agent own account', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount: OTHER_ADDRESS, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/not delegated by/)
  })

  it('refuses a child whose delegate does not match the declared child delegate', () => {
    const expected = defaultExpectation(ownAccount, OTHER_ADDRESS)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/delegate does not match/)
  })

  it('refuses a ROOT authority (a sub-budget always chains under the budget)', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, authority: ROOT_AUTHORITY as Hex, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/ROOT/)
  })

  it('refuses an authority that chains under a different parent than declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, authority: `0x${'33'.repeat(32)}` as Hex, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/different parent/)
  })

  it('refuses a HARD-CAP amount caveat (the task-budget shape) on this channel', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({
      ownAccount,
      expiresAt: expected.expiresAt,
      extraCaveat: {
        enforcer: CAVEAT_ENFORCERS.erc20TransferAmount as Address,
        terms: `0x${TOKEN.slice(2).toLowerCase()}${(100n).toString(16).padStart(64, '0')}` as Hex,
      },
    })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/task-budget shape/)
  })

  it('refuses a child with no period caveat (not bounded to a per-period amount)', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, omitPeriod: true, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/no ERC-20 period-transfer caveat/)
  })

  it('refuses a child spending a different token than declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, token: OTHER_ADDRESS, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/different token/)
  })

  it('refuses a period amount that does not match the declared slice', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, periodAmount: 101n, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/period amount does not match/)
  })

  it('refuses a child on a DIFFERENT period clock than the parent window Haven declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, periodDuration: 604_800, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/period duration does not match/)
  })

  it('refuses a child on a different period anchor than the parent start Haven declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, startDate: 1_700_000_001, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/period start does not match/)
  })

  it('refuses an open-ended child (no timestamp caveat)', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, omitTimestamp: true, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/never expires/)
  })

  it('refuses an already-expired child', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: Math.floor(Date.now() / 1000) - 10 })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/already expired/)
  })

  it('refuses an expiry that does not match what Haven declared', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt + 1 })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/expiry does not match/)
  })

  it('a PINNED sub-budget requires the recipient pin at offset 4', () => {
    const expected = { ...defaultExpectation(ownAccount), recipientAddress: RECIPIENT }
    const noPin = buildSubBudgetChildTypedData({ ownAccount, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(noPin, expected, delegateAddress)).toThrow(/no recipient pin/)
    const wrongOffset = buildSubBudgetChildTypedData({ ownAccount, recipient: RECIPIENT, expiresAt: expected.expiresAt })
    wrongOffset.message.caveats = wrongOffset.message.caveats.map((c) =>
      c.enforcer.toLowerCase() === (CAVEAT_ENFORCERS.allowedCalldata as string).toLowerCase()
        ? { ...c, terms: `0x${(8).toString(16).padStart(64, '0')}${pad(RECIPIENT, { size: 32 }).slice(2)}` as Hex }
        : c,
    )
    expect(() => assertOwnSubBudgetChild(wrongOffset, expected, delegateAddress)).toThrow(/wrong calldata offset/)
    const otherRecipient = buildSubBudgetChildTypedData({ ownAccount, recipient: OTHER_ADDRESS, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(otherRecipient, expected, delegateAddress)).toThrow(/different recipient/)
  })

  it('an UNPINNED sub-budget must not grow a recipient pin', () => {
    const expected = defaultExpectation(ownAccount)
    const td = buildSubBudgetChildTypedData({ ownAccount, recipient: RECIPIENT, expiresAt: expected.expiresAt })
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).toThrow(/not issued with/)
  })

  it('hashSubBudgetDelegation matches the KIT own struct hash', () => {
    const td = buildSubBudgetChildTypedData({ ownAccount })
    const m = td.message as unknown as {
      delegate: Address
      delegator: Address
      authority: Hex
      caveats: { enforcer: Address; terms: Hex; args: Hex }[]
      salt: string
    }
    const delegation = {
      delegate: m.delegate,
      delegator: m.delegator,
      authority: m.authority,
      caveats: m.caveats,
      salt: BigInt(m.salt),
    }
    expect(hashSubBudgetDelegation(delegation as never)).toBe(kitHashDelegation(delegation as never))
  })

  it('accepts a REAL kit-built child — the period decode matches the kit tight-packed terms', () => {
    // Build the parent-child exactly as the backend builder does (kit
    // `createDelegation`, period scope, timestamp caveat) and run the guard
    // over a typed data payload carrying the KIT'S OWN caveat terms bytes.
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const parent = {
      delegate: ownAccount,
      delegator: OTHER_ADDRESS,
      authority: PARENT_HASH,
      caveats: [] as { enforcer: Address; terms: Hex; args: Hex }[],
      salt: 1n,
      signature: `0x${'ab'.repeat(65)}` as Hex,
    }
    const child = createDelegation({
      environment: getSmartAccountsEnvironment(CHAIN_ID),
      from: ownAccount,
      to: ownAccount,
      parentDelegation: parent as never,
      scope: {
        type: 'erc20PeriodTransfer',
        tokenAddress: TOKEN,
        periodAmount: 1_000_000n,
        periodDuration: 86_400,
        startDate: 1_700_000_000,
      },
      caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: expiresAt }] as never,
      salt: `0x${'11'.repeat(32)}` as Hex,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as {
      delegate: Address
      delegator: Address
      authority: Hex
      caveats: { enforcer: Address; terms: Hex }[]
      salt: bigint
    }
    const td = {
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
      primaryType: 'Delegation' as const,
      message: {
        delegate: child.delegate,
        delegator: child.delegator,
        authority: child.authority,
        caveats: (child.caveats as Array<{ enforcer: Address; terms: Hex; args?: Hex }>).map((c) => ({
          enforcer: c.enforcer,
          terms: c.terms,
          args: c.args ?? ('0x' as Hex),
        })),
        salt: child.salt.toString(),
      },
    }
    const expected: SubBudgetChildExpectation = {
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      periodAmountAtomic: '1000000',
      periodDurationSeconds: 86_400,
      startDate: 1_700_000_000,
      recipientAddress: null,
      expiresAt,
      parentDelegationHash: kitHashDelegation(parent as never),
      delegateAccount: ownAccount,
      childDelegateAccount: ownAccount,
    }
    expect(() => assertOwnSubBudgetChild(td, expected, delegateAddress)).not.toThrow()
  })
})

// ── assertOwnSubBudgetCloseUserOp ───────────────────────────────────────────

const DISABLE_DELEGATION_ABI = [
  {
    type: 'function',
    name: 'disableDelegation',
    inputs: [{ name: 'delegation', type: 'tuple', components: DELEGATION_TUPLE_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

function buildCloseUserOp(opts: { delegateAddress: Address; delegationHash?: Hex }) {
  const sender = deriveDelegateAccountAddress(opts.delegateAddress)
  const delegation = {
    delegate: sender,
    delegator: sender,
    authority: PARENT_HASH,
    caveats: [] as { enforcer: Address; terms: Hex; args: Hex }[],
    salt: 1n,
    signature: `0x${'ab'.repeat(65)}` as Hex,
  }
  const innerCallData = encodeFunctionData({
    abi: DISABLE_DELEGATION_ABI,
    functionName: 'disableDelegation',
    args: [delegation],
  })
  const callData = buildExecuteCallData(DELEGATION_MANAGER as Address, 0n, innerCallData)
  const typedData = {
    domain: {
      name: HYBRID_DELEGATOR_DOMAIN_NAME,
      version: HYBRID_DELEGATOR_DOMAIN_VERSION,
      chainId: CHAIN_ID,
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
  return { typedData, delegationHash: opts.delegationHash ?? kitHashDelegation(delegation as never) }
}

describe('assertOwnSubBudgetCloseUserOp', () => {
  const key = generatePrivateKey()
  const delegateAddress = privateKeyToAccount(key).address

  it('accepts a well-formed disableDelegation(own self-delegated child) UserOp', () => {
    const { typedData, delegationHash } = buildCloseUserOp({ delegateAddress })
    expect(() =>
      assertOwnSubBudgetCloseUserOp(typedData as unknown as Record<string, unknown>, { delegationHash }, delegateAddress),
    ).not.toThrow()
  })

  it('refuses a close naming a different delegation than declared', () => {
    const { typedData } = buildCloseUserOp({ delegateAddress })
    expect(() =>
      assertOwnSubBudgetCloseUserOp(
        typedData as unknown as Record<string, unknown>,
        { delegationHash: `0x${'44'.repeat(32)}` as Hex },
        delegateAddress,
      ),
    ).toThrow(HavenTypedDataRefusedError)
  })
})
