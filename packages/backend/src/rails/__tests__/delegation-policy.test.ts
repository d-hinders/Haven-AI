import { describe, expect, it } from 'vitest'
import { encodeFunctionData, decodeFunctionData, encodeAbiParameters, pad, toHex } from 'viem'
import {
  assertUserOperationDisablesDelegations,
  buildBudgetDelegation,
  buildMultiTokenBudgetDelegation,
  buildRevocation,
  decodeUserOperationCalls,
  delegationIdentity,
  delegationSigningPayload,
  DISABLE_DELEGATION_ABI_ITEM,
  getDelegationEnvironment,
  type HavenBudgetPolicy,
} from '../delegation-policy.js'
import { getDelegationContracts } from '../delegation-contracts.js'
import { contracts, ExecutionMode, createExecution, type Delegation } from '@metamask/smart-accounts-kit'
import { DeleGatorCore } from '@metamask/delegation-abis'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const EURE = ('0x' + '99'.repeat(20)) as `0x${string}`
const TREASURY = ('0x' + 'aa'.repeat(20)) as `0x${string}`
const DELEGATE = ('0x' + 'bb'.repeat(20)) as `0x${string}`
const RECIPIENT = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const NOW = 1_900_000_000

/** kit encoders and the hand-declared ABI both take the full struct — rows store it signature-less. */
function withSig(d: Omit<Delegation, 'signature'>): Delegation {
  return { ...d, signature: '0x' }
}

function policy(overrides: Partial<HavenBudgetPolicy> = {}): HavenBudgetPolicy {
  return {
    agentId: '11111111-1111-1111-1111-111111111111',
    chainId: 84532,
    treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE,
    tokenAddress: USDC,
    budgetAtomic: 5_000_000n,
    periodSeconds: 86_400,
    startDate: NOW - 60,
    recipient: RECIPIENT,
    expiresAt: NOW + 90 * 86_400,
    version: 1,
    ...overrides,
  }
}

describe('getDelegationEnvironment — anti-drift cross-check (#825 promise)', () => {
  it('kit environment matches every pinned address', () => {
    expect(() => getDelegationEnvironment(84532)).not.toThrow()
  })
  it('fails loudly on a chain without pins', () => {
    expect(() => getDelegationEnvironment(1)).toThrow(/no pinned contracts/)
  })
})

describe('identity (#813 encoded as regression tests)', () => {
  it('is deterministic: same policy → bit-identical delegation and hash', () => {
    const a = buildBudgetDelegation(policy())
    const b = buildBudgetDelegation(policy())
    expect(delegationIdentity(a)).toBe(delegationIdentity(b))
    expect(a).toEqual(b)
  })

  it('two recipients NEVER share an identity (the #813 collision class)', () => {
    const a = buildBudgetDelegation(policy())
    const b = buildBudgetDelegation(policy({ recipient: ('0x' + 'dd'.repeat(20)) as `0x${string}` }))
    expect(delegationIdentity(a)).not.toBe(delegationIdentity(b))
  })

  it('open and pinned budgets differ; two open budgets for different tokens differ', () => {
    const open = buildBudgetDelegation(policy({ recipient: undefined }))
    const pinned = buildBudgetDelegation(policy())
    const openEure = buildBudgetDelegation(policy({ recipient: undefined, tokenAddress: EURE }))
    expect(delegationIdentity(open)).not.toBe(delegationIdentity(pinned))
    expect(delegationIdentity(open)).not.toBe(delegationIdentity(openEure))
  })

  it('a replacement (version bump) is a fresh identity', () => {
    const v1 = buildBudgetDelegation(policy())
    const v2 = buildBudgetDelegation(policy({ version: 2 }))
    expect(delegationIdentity(v1)).not.toBe(delegationIdentity(v2))
  })

  it('identity never depends on address casing', () => {
    const lower = buildBudgetDelegation(policy({ recipient: RECIPIENT.toLowerCase() as `0x${string}` }))
    const upper = buildBudgetDelegation(
      policy({ recipient: RECIPIENT.toUpperCase().replace('0X', '0x') as `0x${string}` }),
    )
    expect(delegationIdentity(lower)).toBe(delegationIdentity(upper))
  })
})

describe('caveat stack contents', () => {
  it('pins the delegate — never an any-beneficiary delegation', () => {
    const open = buildBudgetDelegation(policy({ recipient: undefined }))
    expect(open.delegate.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })

  it('recipient pin is the padded transfer `to` word at byte 4, via the pinned enforcer', () => {
    const d = buildBudgetDelegation(policy())
    const pins = getDelegationContracts(84532)
    const calldataCaveat = d.caveats.find(
      (c) => c.enforcer.toLowerCase() === pins.enforcers.allowedCalldata.toLowerCase(),
    )
    expect(calldataCaveat).toBeDefined()
    expect(calldataCaveat!.terms.toLowerCase()).toContain(
      pad(RECIPIENT.toLowerCase() as `0x${string}`, { size: 32 }).slice(2).toLowerCase(),
    )
  })

  it('the open variant carries NO calldata pin', () => {
    const d = buildBudgetDelegation(policy({ recipient: undefined }))
    const pins = getDelegationContracts(84532)
    expect(
      d.caveats.some((c) => c.enforcer.toLowerCase() === pins.enforcers.allowedCalldata.toLowerCase()),
    ).toBe(false)
  })

  it('period budget + expiry ride the pinned period/timestamp enforcers', () => {
    const d = buildBudgetDelegation(policy())
    const pins = getDelegationContracts(84532)
    const enforcers = d.caveats.map((c) => c.enforcer.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.erc20PeriodTransfer.toLowerCase())
    expect(enforcers).toContain(pins.enforcers.timestamp.toLowerCase())
  })

  it('optional lifetime cap adds the cumulative enforcer — and rejects a cap below one period', () => {
    const d = buildBudgetDelegation(policy({ lifetimeCapAtomic: 100_000_000n }))
    const pins = getDelegationContracts(84532)
    expect(d.caveats.map((c) => c.enforcer.toLowerCase())).toContain(
      pins.enforcers.erc20TransferAmount.toLowerCase(),
    )
    expect(() => buildBudgetDelegation(policy({ lifetimeCapAtomic: 1n }))).toThrow(/lifetime cap/)
  })

  it('validates inputs (budget, period, expiry ordering)', () => {
    expect(() => buildBudgetDelegation(policy({ budgetAtomic: 0n }))).toThrow(/budget/)
    expect(() => buildBudgetDelegation(policy({ periodSeconds: 0 }))).toThrow(/period/)
    expect(() => buildBudgetDelegation(policy({ expiresAt: NOW - 120 }))).toThrow(/expiry/)
  })
})

describe('multi-token budget (one delegation, #804 concept)', () => {
  it('carries per-token period budgets via the pinned MultiTokenPeriodEnforcer', () => {
    const d = buildMultiTokenBudgetDelegation(
      {
        agentId: 'a', chainId: 84532, treasuryAddress: TREASURY,
        delegateAccountAddress: DELEGATE, expiresAt: NOW + 86_400, version: 1,
        lifetimeCapAtomic: undefined,
      },
      [
        { tokenAddress: USDC, budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60 },
        { tokenAddress: EURE, budgetAtomic: 2_000_000n, periodSeconds: 86_400, startDate: NOW - 60 },
      ],
    )
    const pins = getDelegationContracts(84532)
    expect(d.caveats.map((c) => c.enforcer.toLowerCase())).toContain(
      pins.enforcers.multiTokenPeriod.toLowerCase(),
    )
    expect(d.delegate.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })
})

describe('signing payload + revocation', () => {
  it('typed data targets the PINNED manager with its own domain constants', () => {
    const d = buildBudgetDelegation(policy())
    const payload = delegationSigningPayload(d, 84532)
    expect(payload.domain.verifyingContract.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
    expect(payload.domain.name).toBe('DelegationManager')
    expect(payload.primaryType).toBe('Delegation')
    expect(payload.message).toEqual(d)
  })

  it('revocation targets the pinned manager with disableDelegation calldata', () => {
    const d = buildBudgetDelegation(policy())
    const revocation = buildRevocation({ ...d, signature: '0x' } as never, 84532)
    expect(revocation.to.toLowerCase()).toBe(
      getDelegationContracts(84532).delegationManager.toLowerCase(),
    )
    expect(revocation.data.startsWith('0x')).toBe(true)
    expect(revocation.data.length).toBeGreaterThan(10)
  })

  // ── #3343: the calldata is DECODED here, not compared to itself ──────────
  // The selector and the delegation are read back from the bytes the kit
  // produced, so mutating the encoder (disableDelegation → enableDelegation,
  // a moved pin, a salt change) turns THIS test red instead of letting the
  // routes test buildRevocation against itself.

  it('buildRevocation encodes disableDelegation — decoded from the bytes, selector and delegation both (#3343)', () => {
    const d = buildBudgetDelegation(policy())
    const revocation = buildRevocation(withSig(d), 84532)
    const inner = decodeFunctionData({ abi: [DISABLE_DELEGATION_ABI_ITEM], data: revocation.data })
    expect(inner.functionName).toBe('disableDelegation')
    const arg = inner.args[0]
    expect(arg.delegate.toLowerCase()).toBe(d.delegate.toLowerCase())
    expect(arg.delegator.toLowerCase()).toBe(d.delegator.toLowerCase())
    expect(arg.authority.toLowerCase()).toBe(d.authority.toLowerCase())
    // salt decodes to bigint; canonicalise back to the 32-byte hex the
    // identity rule uses and compare identities — signature-excluded.
    expect(delegationIdentity({
      delegate: arg.delegate,
      delegator: arg.delegator,
      authority: arg.authority,
      caveats: arg.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
      salt: `0x${arg.salt.toString(16).padStart(64, '0')}`,
    })).toBe(delegationIdentity(d))
  })

  it('the hand-declared disableDelegation ABI is byte-equal to the kit encoding it must read (#3343)', () => {
    const d = buildBudgetDelegation(policy())
    const viaKit = contracts.DelegationManager.encode.disableDelegation({ delegation: withSig(d) })
    const viaDecl = encodeFunctionData({
      abi: [DISABLE_DELEGATION_ABI_ITEM],
      functionName: 'disableDelegation',
      args: [d as never],
    })
    expect(viaDecl).toBe(viaKit)
  })
})

// ── #3343: binding a submitted owner op to the revocations it executes ──────

const EXECUTE_SINGLE_ABI = [{
  type: 'function',
  name: 'execute',
  inputs: [{
    name: 'execution',
    type: 'tuple',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  }],
  outputs: [],
  stateMutability: 'payable',
}] as const

const EXECUTE_WITH_MODE_ABI = [{
  type: 'function',
  name: 'execute',
  inputs: [
    { name: 'mode', type: 'bytes32' },
    { name: 'executionData', type: 'bytes' },
  ],
  outputs: [],
  stateMutability: 'payable',
}] as const

const EXECUTION_TUPLE = [{
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
  name: 'executions',
  type: 'tuple[]',
}] as const

describe('decodeUserOperationCalls — the kit execution envelope (#3343)', () => {
  const target = getDelegationContracts(84532).delegationManager
  const inner = ('0x49934047' + 'ab'.repeat(64)) as `0x${string}`

  it('flattens the single-execute envelope (execute(Execution), 0x5c1c6dcd)', () => {
    const callData = encodeFunctionData({
      abi: EXECUTE_SINGLE_ABI,
      functionName: 'execute',
      args: [{ target, value: 0n, callData: inner }],
    })
    expect(decodeUserOperationCalls(callData)).toEqual([{ to: target, data: inner }])
  })

  it('flattens the kit batch envelope (executeWithMode, BatchDefault → Execution[])', () => {
    const calls = [
      { to: target, data: inner },
      { to: ('0x' + '33'.repeat(20)) as `0x${string}`, data: ('0xbeef' as `0x${string}`) },
    ]
    const callData = encodeFunctionData({
      abi: EXECUTE_WITH_MODE_ABI,
      functionName: 'execute',
      args: [
        ExecutionMode.BatchDefault,
        encodeAbiParameters(EXECUTION_TUPLE, [calls.map((c) => ({ target: c.to, value: 0n, callData: c.data }))]),
      ],
    })
    expect(decodeUserOperationCalls(callData)).toEqual(calls)
  })

  it('flattens the kit SINGLE-call userop exactly as the kit itself encodes it', () => {
    const exec = createExecution({ target, value: 0n, callData: inner })
    const callData = encodeFunctionData({ abi: DeleGatorCore, functionName: 'execute', args: [exec] })
    expect(decodeUserOperationCalls(callData)).toEqual([{ to: target, data: inner }])
  })

  it('refuses a try-mode batch (individual reverts could hide behind receipt.success)', () => {
    const callData = encodeFunctionData({
      abi: EXECUTE_WITH_MODE_ABI,
      functionName: 'execute',
      args: [
        ExecutionMode.BatchTry,
        encodeAbiParameters(EXECUTION_TUPLE, [[{ target, value: 0n, callData: inner }]]),
      ],
    })
    expect(decodeUserOperationCalls(callData)).toBeNull()
  })

  it('returns null for garbage, truncation, and unknown envelopes', () => {
    expect(decodeUserOperationCalls('0xdeadbeef')).toBeNull()
    expect(decodeUserOperationCalls('0x')).toBeNull()
    expect(decodeUserOperationCalls('not-hex')).toBeNull()
    expect(decodeUserOperationCalls(undefined as unknown as string)).toBeNull()
    // right selector, truncated body
    expect(decodeUserOperationCalls(('0x5c1c6dcd' + '00'.repeat(4)) as `0x${string}`)).toBeNull()
  })
})

describe('assertUserOperationDisablesDelegations — the #3343 invariant', () => {
  const chainId = 84532
  const d = buildBudgetDelegation(policy())
  const rowJson = JSON.stringify({ ...d, signature: '0x' + 'cd'.repeat(65) })
  const row = { delegation_hash: delegationIdentity(d), delegation_json: rowJson }

  /** A kit-genuine single userop disabling the row's delegation. */
  function boundOp(): string {
    const revocation = buildRevocation(withSig(d), chainId)
    return encodeFunctionData({
      abi: EXECUTE_SINGLE_ABI,
      functionName: 'execute',
      args: [{ target: revocation.to, value: 0n, callData: revocation.data }],
    })
  }

  /** The same envelope with enableDelegation in place of disableDelegation. */
  function invertedOp(): string {
    const enable = contracts.DelegationManager.encode.enableDelegation({ delegation: withSig(d) })
    return encodeFunctionData({
      abi: EXECUTE_SINGLE_ABI,
      functionName: 'execute',
      args: [{ target: getDelegationContracts(chainId).delegationManager, value: 0n, callData: enable }],
    })
  }

  function executeEnvelope(calls: Array<{ to: `0x${string}`; data: `0x${string}` }>): string {
    const execs = calls.map((c) => ({ target: c.to, value: 0n, callData: c.data }))
    if (execs.length === 1) {
      return encodeFunctionData({
        abi: EXECUTE_SINGLE_ABI,
        functionName: 'execute',
        args: [execs[0]!],
      })
    }
    return encodeFunctionData({
      abi: EXECUTE_WITH_MODE_ABI,
      functionName: 'execute',
      args: [ExecutionMode.BatchDefault, encodeAbiParameters(EXECUTION_TUPLE, [execs])],
    })
  }

  it('accepts a kit-encoded op that disables the expected delegation (subset mode)', () => {
    const result = assertUserOperationDisablesDelegations(boundOp(), chainId, [row], 'subset')
    expect(result).toEqual({ ok: true, disabled: [row.delegation_hash] })
  })

  it('accepts the same op in exact mode', () => {
    const result = assertUserOperationDisablesDelegations(boundOp(), chainId, [row], 'exact')
    expect(result.ok).toBe(true)
  })

  it('REFUSES the enableDelegation mutation — the assertion the old suite could never make', () => {
    const result = assertUserOperationDisablesDelegations(invertedOp(), chainId, [row], 'subset')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })

  it('refuses an op disabling a DIFFERENT delegation (fresh version → different salt)', () => {
    const other = buildBudgetDelegation(policy({ version: 2 }))
    const callData = executeEnvelope([buildRevocation(withSig(other), chainId)])
    const result = assertUserOperationDisablesDelegations(callData, chainId, [row], 'subset')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })

  it('refuses a disable aimed at a NON-pinned contract (moved pin class)', () => {
    const rogue = ('0x' + '77'.repeat(20)) as `0x${string}`
    const data = contracts.DelegationManager.encode.disableDelegation({ delegation: withSig(d) })
    const result = assertUserOperationDisablesDelegations(
      executeEnvelope([{ to: rogue, data }]),
      chainId,
      [row],
      'subset',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })

  it('exact mode refuses an op that disables MORE than the server holds (extra); subset mode tolerates it', () => {
    const d2 = buildBudgetDelegation(policy({ version: 2 }))
    const callData = executeEnvelope([buildRevocation(withSig(d), chainId), buildRevocation(withSig(d2), chainId)])
    const subset = assertUserOperationDisablesDelegations(callData, chainId, [row], 'subset')
    expect(subset.ok).toBe(true)
    const exact = assertUserOperationDisablesDelegations(callData, chainId, [row], 'exact')
    expect(exact.ok).toBe(false)
    if (!exact.ok) expect(exact.reason).toBe('extra')
  })

  it('exact mode accepts a two-row batch derived from kit encodings', () => {
    const d2 = buildBudgetDelegation(policy({ version: 2 }))
    const rows = [
      { delegation_hash: delegationIdentity(d), delegation_json: JSON.stringify(d) },
      { delegation_hash: delegationIdentity(d2), delegation_json: JSON.stringify(d2) },
    ]
    const callData = executeEnvelope([buildRevocation(withSig(d), chainId), buildRevocation(withSig(d2), chainId)])
    expect(assertUserOperationDisablesDelegations(callData, chainId, rows, 'exact')).toEqual({
      ok: true,
      disabled: rows.map((r) => r.delegation_hash),
    })
  })

  it('refuses an undecodable callData (the old { nonce: "1n" } fixture shape)', () => {
    const result = assertUserOperationDisablesDelegations(undefined, chainId, [row], 'subset')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('undecodable')
  })
})
