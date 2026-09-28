/**
 * Caveat compiler (#827, epic #821 Phase 2): Haven agent policy → a signed-
 * ready delegation with its caveat stack. Pure construction — no DB, no
 * network, no signing. The lifecycle module (#828) persists and orchestrates;
 * the dashboard signs; this module only compiles.
 *
 * Policy mapping (the vocabulary of Haven's moat, per the mental-models doc):
 *
 *   Haven concept              → enforcer (pinned, audited)
 *   ─────────────────────────────────────────────────────────
 *   per-period budget w/refill → ERC20PeriodTransferEnforcer (scope)
 *   multi-token budget         → MultiTokenPeriodEnforcer (one delegation)
 *   recipient pin              → AllowedCalldataEnforcer (transfer `to` arg)
 *   open budget (#810)         → the same delegation WITHOUT the pin
 *   validity window            → TimestampEnforcer
 *   lifetime cap (optional)    → ERC20TransferAmountEnforcer (cumulative —
 *                                NOT per-tx; the period budget is what bounds
 *                                burst, exactly like the AllowanceModule)
 *
 * Identity (#813 encoded forever): the salt derives from agentId + chainId +
 * token + recipient(+ 'open') + a caller-managed VERSION — so two recipients
 * can never collide to one on-chain identity, replacement produces a fresh
 * identity (disableDelegation on the old cannot be undone by accident), and
 * everything is lowercased first so identity never depends on address casing.
 *
 * The DELEGATE is always the agent's delegate account (#826's Hybrid) — never
 * ANY_BENEFICIARY: an open BUDGET is open in its recipient, not in who may
 * redeem. (The #820 spike used an any-redeemer delegation for its open case;
 * that was fine for a matrix probe and wrong for a product — encoded here.)
 */

import { keccak256, toUtf8Bytes, Interface } from 'ethers'
import {
  decodeFunctionData,
  decodeAbiParameters,
  recoverTypedDataAddress,
  pad,
  type Address,
  type Hex,
} from 'viem'
import {
  createDelegation,
  getSmartAccountsEnvironment,
  contracts,
  type Delegation,
} from '@metamask/smart-accounts-kit'
import { hashDelegation, SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils'
import { getDelegationContracts } from './delegation-contracts.js'

const ERC20_IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

/**
 * The kit's environment for a chain, CROSS-CHECKED against Haven's pinned
 * addresses — a package upgrade that silently moves the manager or an
 * enforcer FAILS here instead of retargeting the money path (#825's promise).
 */
export function getDelegationEnvironment(chainId: number) {
  const pins = getDelegationContracts(chainId)
  const env = getSmartAccountsEnvironment(chainId)
  const mismatches: string[] = []
  if (env.DelegationManager.toLowerCase() !== pins.delegationManager.toLowerCase()) {
    mismatches.push(`DelegationManager ${env.DelegationManager} != pinned ${pins.delegationManager}`)
  }
  const enforcerPins: Array<[string, string]> = [
    ['ERC20PeriodTransferEnforcer', pins.enforcers.erc20PeriodTransfer],
    ['MultiTokenPeriodEnforcer', pins.enforcers.multiTokenPeriod],
    ['AllowedCalldataEnforcer', pins.enforcers.allowedCalldata],
    ['TimestampEnforcer', pins.enforcers.timestamp],
    ['ERC20TransferAmountEnforcer', pins.enforcers.erc20TransferAmount],
    // #1058: the settlement child's redeemer pin is money-path — a kit
    // upgrade silently moving this enforcer must fail the drift guard.
    ['RedeemerEnforcer', pins.enforcers.redeemer],
  ]
  for (const [name, pinned] of enforcerPins) {
    const fromKit = (env.caveatEnforcers as Record<string, string>)[name]
    if (!fromKit || fromKit.toLowerCase() !== pinned.toLowerCase()) {
      mismatches.push(`${name} ${fromKit} != pinned ${pinned}`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `delegation contracts drift (kit vs pinned) — REFUSING to build:\n${mismatches.join('\n')}`,
    )
  }
  return env
}

export interface HavenBudgetPolicy {
  /** Stable Haven agent id — identity input. */
  agentId: string
  chainId: number
  /** The treasury (delegator) — the user's Hybrid account. */
  treasuryAddress: Address
  /** The agent's delegate account (#826's agent-owned Hybrid) — the redeemer. */
  delegateAccountAddress: Address
  tokenAddress: Address
  /** Per-period budget in atomic units; refills natively on the clock. */
  budgetAtomic: bigint
  periodSeconds: number
  /**
   * Period anchor (unix seconds). Anchor ~60 s in the past of "now" — local
   * clocks run ahead of chain time (paid for live in #820 run 6).
   */
  startDate: number
  /** Pinned recipient; undefined = open budget (#810's second mode). */
  recipient?: Address
  /** Delegation is unusable after this unix timestamp. */
  expiresAt: number
  /** OPTIONAL cumulative lifetime cap (NOT per-tx) on top of the period budget. */
  lifetimeCapAtomic?: bigint
  /** Bumped by the lifecycle (#828) on every replacement — identity input. */
  version: number
}

/** Deterministic, distinct, replaceable identity — see the header. */
export function delegationSalt(policy: HavenBudgetPolicy): Hex {
  const recipient = policy.recipient ? policy.recipient.toLowerCase() : 'open'
  return keccak256(
    toUtf8Bytes(
      `haven-delegation:${policy.agentId}:${policy.chainId}:${policy.tokenAddress.toLowerCase()}:${recipient}:${policy.version}`,
    ),
  ) as Hex
}

/** The unsigned delegation for a Haven budget policy. */
export function buildBudgetDelegation(policy: HavenBudgetPolicy): Omit<Delegation, 'signature'> {
  if (policy.budgetAtomic <= 0n) throw new Error('budget must be positive')
  if (policy.periodSeconds <= 0) throw new Error('period must be positive')
  if (policy.expiresAt <= policy.startDate) throw new Error('expiry must be after the period anchor')

  const env = getDelegationEnvironment(policy.chainId)
  const caveats: Array<Record<string, unknown>> = []
  if (policy.recipient) {
    // transfer(to, amount): `to` is the 32-byte-padded word at calldata byte 4.
    caveats.push({
      type: 'allowedCalldata',
      startIndex: 4,
      value: pad(policy.recipient.toLowerCase() as Hex, { size: 32 }),
    })
  }
  caveats.push({ type: 'timestamp', afterThreshold: 0, beforeThreshold: policy.expiresAt })
  if (policy.lifetimeCapAtomic !== undefined) {
    if (policy.lifetimeCapAtomic < policy.budgetAtomic) {
      throw new Error('a lifetime cap below one period budget can never be spent sanely')
    }
    caveats.push({
      type: 'erc20TransferAmount',
      tokenAddress: policy.tokenAddress,
      maxAmount: policy.lifetimeCapAtomic,
    })
  }

  return createDelegation({
    environment: env,
    from: policy.treasuryAddress,
    to: policy.delegateAccountAddress, // never ANY_BENEFICIARY — see header
    scope: {
      type: 'erc20PeriodTransfer',
      tokenAddress: policy.tokenAddress,
      periodAmount: policy.budgetAtomic,
      periodDuration: policy.periodSeconds,
      startDate: policy.startDate,
    },
    caveats: caveats as never,
    salt: delegationSalt(policy),
  })
}

export interface MultiTokenBudget {
  tokenAddress: Address
  budgetAtomic: bigint
  periodSeconds: number
  startDate: number
}

/**
 * One delegation covering several tokens' period budgets (the #804 concept
 * in ONE grant): functionCall scope over the token contracts' transfer, with
 * MultiTokenPeriodEnforcer carrying per-token budgets. Recipient pinning is
 * intentionally not offered here — a pinned recipient with multiple tokens is
 * N single-token delegations (the calldata pin is per-call-shape).
 */
export function buildMultiTokenBudgetDelegation(
  base: Omit<HavenBudgetPolicy, 'tokenAddress' | 'budgetAtomic' | 'periodSeconds' | 'startDate' | 'recipient'>,
  budgets: MultiTokenBudget[],
): Omit<Delegation, 'signature'> {
  if (budgets.length === 0) throw new Error('at least one token budget is required')
  const env = getDelegationEnvironment(base.chainId)
  const salt = keccak256(
    toUtf8Bytes(
      `haven-delegation:${base.agentId}:${base.chainId}:multi:${budgets
        .map((b) => b.tokenAddress.toLowerCase())
        .sort()
        .join(',')}:open:${base.version}`,
    ),
  ) as Hex
  return createDelegation({
    environment: env,
    from: base.treasuryAddress,
    to: base.delegateAccountAddress,
    scope: {
      type: 'functionCall',
      targets: budgets.map((b) => b.tokenAddress),
      selectors: [ERC20_IFACE.getFunction('transfer')!.selector as Hex],
    },
    caveats: [
      {
        type: 'multiTokenPeriod',
        tokenConfigs: budgets.map((b) => ({
          token: b.tokenAddress,
          periodAmount: b.budgetAtomic,
          periodDuration: b.periodSeconds,
          startDate: b.startDate,
        })),
      },
      { type: 'timestamp', afterThreshold: 0, beforeThreshold: base.expiresAt },
    ] as never,
    salt,
  })
}

/** The identity of a delegation (what disableDelegation targets). */
export function delegationIdentity(delegation: Omit<Delegation, 'signature'>): Hex {
  return hashDelegation({ ...delegation, signature: '0x' } as Delegation)
}

/**
 * The EIP-712 payload the OWNER signs client-side (dashboard, #828) — the
 * backend never signs (#824 invariant 12). Verify domain against the pinned
 * manager; name/version from the manager's own constants.
 */
export function delegationSigningPayload(
  delegation: Omit<Delegation, 'signature'>,
  chainId: number,
): {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: typeof SIGNABLE_DELEGATION_TYPED_DATA
  primaryType: 'Delegation'
  message: Omit<Delegation, 'signature'>
} {
  const pins = getDelegationContracts(chainId)
  return {
    domain: {
      name: contracts.DelegationManager.constants.NAME,
      version: contracts.DelegationManager.constants.DOMAIN_VERSION,
      chainId,
      verifyingContract: pins.delegationManager,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: 'Delegation',
    message: delegation,
  }
}

/**
 * Recover the EOA that signed a delegation's EIP-712 payload (#1053 review,
 * finding 3). Lives here rather than in the route: `routes/**` may not import
 * viem (the chain-sdk boundary rule), and signature semantics belong with the
 * signing payload they verify.
 */
export async function recoverDelegationSigner(
  delegation: Omit<Delegation, 'signature'>,
  chainId: number,
  signature: `0x${string}`,
): Promise<string> {
  const payload = delegationSigningPayload(delegation, chainId)
  return recoverTypedDataAddress({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as never,
    signature,
  })
}

/** Revocation call for the treasury to execute: disableDelegation(delegation). */
export function buildRevocation(
  delegation: Delegation,
  chainId: number,
): { to: Address; data: Hex } {
  const pins = getDelegationContracts(chainId)
  const data = contracts.DelegationManager.encode.disableDelegation({ delegation }) as Hex
  return { to: pins.delegationManager, data }
}

// ── Binding submitted owner ops to the revocations they execute (#3343) ────
//
// The prepare routes build the disableDelegation calldata from the SERVER's
// own delegation rows; the submit routes used to record `revoked` for
// whatever hashes the client paired with the signature — an op whose calldata
// disabled something else, or nothing, still flipped the rows. The same class
// of gap was closed for the other two owner-submit sites with #906 ("so the
// stored signer set can never diverge from what was signed on-chain"); this
// is the delegation-rail twin.
//
// The decoder below is deliberately INDEPENDENT of `buildRevocation`: it
// hand-declares the ABI shapes and re-derives the identity from DECODED
// bytes, so a test that mutates the encoder (disableDelegation →
// enableDelegation, a moved pin, a different salt rule) turns red here
// instead of the routes testing the builder against itself.

/** The kit 1.6.0 DelegationManager.disableDelegation ABI item, hand-declared. */
export const DISABLE_DELEGATION_ABI_ITEM = {
  type: 'function',
  name: 'disableDelegation',
  inputs: [
    {
      name: '_delegation',
      type: 'tuple',
      internalType: 'struct Delegation',
      components: [
        { name: 'delegate', type: 'address', internalType: 'address' },
        { name: 'delegator', type: 'address', internalType: 'address' },
        { name: 'authority', type: 'bytes32', internalType: 'bytes32' },
        {
          name: 'caveats',
          type: 'tuple[]',
          internalType: 'struct Caveat[]',
          components: [
            { name: 'enforcer', type: 'address', internalType: 'address' },
            { name: 'terms', type: 'bytes', internalType: 'bytes' },
            { name: 'args', type: 'bytes', internalType: 'bytes' },
          ],
        },
        { name: 'salt', type: 'uint256', internalType: 'uint256' },
        { name: 'signature', type: 'bytes', internalType: 'bytes' },
      ],
    },
  ],
  outputs: [],
  stateMutability: 'nonpayable',
} as const

/** Account-level execution envelope, hand-declared (ERC-7821-shaped). */
const EXECUTE_SINGLE_ABI = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      {
        name: 'execution',
        type: 'tuple',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const

const EXECUTE_WITH_MODE_ABI = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      { name: 'mode', type: 'bytes32' },
      { name: 'executionData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const

const EXECUTION_TUPLE = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'callData', type: 'bytes' },
] as const

/** kit ExecutionMode.SingleDefault — the packed-single executionData form. */
const MODE_SINGLE_DEFAULT = `0x${'00'.repeat(32)}` as Hex
/** kit ExecutionMode.BatchDefault — the atomic batch the prepare routes build. */
export const MODE_BATCH_DEFAULT = `0x01${'00'.repeat(31)}` as Hex
/** execType byte (mode byte 1): 0x00 = default (revert on failure). */
const EXEC_TYPE_DEFAULT = '00'

export interface DecodedUserOperationCall {
  to: Address
  data: Hex
}

/**
 * Flatten a Hybrid account UserOp callData into its per-call (to, data) list.
 *
 * kit 1.6.0 envelope (verified against @metamask/smart-accounts-kit dist):
 *  - a single call to another contract → `execute(Execution)` (selector
 *    0x5c1c6dcd);
 *  - a batch → `execute(bytes32 mode, bytes executionData)` (selector
 *    0xe9ae5c53), executionData an ABI-encoded Execution[].
 *
 * Returns null when the calldata matches NO known envelope shape — the
 * callers treat that as a failed binding, not as a crash.
 */
export function decodeUserOperationCalls(callData: string): DecodedUserOperationCall[] | null {
  if (typeof callData !== 'string' || !callData.startsWith('0x') || callData.length < 10) {
    return null
  }
  const selector = callData.slice(0, 10).toLowerCase()
  try {
    if (selector === '0x5c1c6dcd') {
      const decoded = decodeFunctionData({ abi: EXECUTE_SINGLE_ABI, data: callData as Hex })
      const exec = decoded.args[0]
      return [{ to: exec.target as Address, data: exec.callData as Hex }]
    }
    if (selector === '0xe9ae5c53') {
      const decoded = decodeFunctionData({ abi: EXECUTE_WITH_MODE_ABI, data: callData as Hex })
      const [mode, executionData] = decoded.args
      // Default execType only (mode byte 1): BatchTry would let individual
      // disable calls revert while receipt.success stays true — the record
      // would then name revocations that never happened. Default reverts the
      // WHOLE op instead. (Byte 0 is the callType — batch vs single.)
      if (mode.slice(4, 6).toLowerCase() !== EXEC_TYPE_DEFAULT) return null
      // Strip '0x' so byte b of the payload starts at char 2b below.
      const h = executionData.slice(2)
      if (mode === MODE_SINGLE_DEFAULT) {
        // EIP-7821 single mode: encodePacked(address, uint256, bytes) — a
        // 32-byte padded target, a 32-byte value, then the RAW call bytes
        // (no offset, no length word).
        const target = `0x${h.slice(24, 64)}` as Address
        const data = `0x${h.slice(128)}` as Hex
        return [{ to: target, data }]
      }
      const [executions] = decodeAbiParameters(
        [{ components: EXECUTION_TUPLE, name: 'executions', type: 'tuple[]' }],
        executionData as Hex,
      )
      return executions.map((e) => ({ to: e.target as Address, data: e.callData as Hex }))
    }
    return null
  } catch {
    return null
  }
}

export type DisableBindingMode = 'subset' | 'exact'

export interface DisableBindingFailure {
  ok: false
  reason: 'undecodable' | 'unsupported_exec_type' | 'wrong_target' | 'wrong_selector' | 'missing' | 'extra'
  expected: string[]
  disabled: string[]
}

export interface DisableBindingSuccess {
  ok: true
  disabled: string[]
}

/**
 * THE invariant (#3343): every delegation about to be recorded `revoked` is
 * disabled by THIS userop's calldata — a `disableDelegation` call aimed at
 * the PINNED DelegationManager whose decoded delegation has the row's
 * identity (signature excluded). `exact` additionally refuses a userop that
 * would disable something the server does not hold as still-enabled (the
 * re-key / revoke-all posture: the owner signed one op and it must cover
 * precisely the server-derived set).
 *
 * Pure: no DB, no network. The routes call this BEFORE submitCall.
 */
export function assertUserOperationDisablesDelegations(
  userOperationCallData: unknown,
  chainId: number,
  expected: Array<{ delegation_hash: string; delegation_json: string }>,
  mode: DisableBindingMode,
): DisableBindingSuccess | DisableBindingFailure {
  const pins = getDelegationContracts(chainId)
  const expectedIds = expected.map((row) => ({
    hash: row.delegation_hash,
    identity: delegationIdentity(JSON.parse(row.delegation_json)),
  }))
  const expectedSet = new Map(expectedIds.map((e) => [e.identity, e.hash]))

  const calls = decodeUserOperationCalls(String(userOperationCallData ?? ''))
  if (calls === null) {
    return { ok: false, reason: 'undecodable', expected: expectedIds.map((e) => e.hash), disabled: [] }
  }
  const disabledHashes: string[] = []
  const disabledIdentities = new Set<string>()
  let disableCallCount = 0
  for (const call of calls) {
    if (call.to.toLowerCase() !== pins.delegationManager.toLowerCase()) continue
    const selector = call.data.slice(0, 10).toLowerCase()
    if (selector !== '0x49934047') continue // disableDelegation — enable/redeem/anything else is not a revoke
    let decoded: { delegate: Address; delegator: Address; authority: Hex; caveats: Array<{ enforcer: Address; terms: Hex; args?: Hex }>; salt: bigint; signature: Hex }
    try {
      const res = decodeFunctionData({ abi: [DISABLE_DELEGATION_ABI_ITEM], data: call.data })
      decoded = res.args[0] as typeof decoded
    } catch {
      return {
        ok: false,
        reason: 'wrong_selector',
        expected: expectedIds.map((e) => e.hash),
        disabled: disabledHashes,
      }
    }
    // Count EVERY decoded disable, matched or not — `exact` must refuse an op
    // that also disables something the server does not hold as still-enabled.
    disableCallCount += 1
    const identity = delegationIdentity({
      delegate: decoded.delegate,
      delegator: decoded.delegator,
      authority: decoded.authority,
      caveats: decoded.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
      salt: `0x${decoded.salt.toString(16).padStart(64, '0')}`,
    })
    disabledIdentities.add(identity)
    const hash = expectedSet.get(identity)
    if (hash) disabledHashes.push(hash)
  }

  const missing = expectedIds.filter((e) => !disabledIdentities.has(e.identity))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing',
      expected: expectedIds.map((e) => e.hash),
      disabled: disabledHashes,
    }
  }
  if (mode === 'exact' && disableCallCount !== expectedIds.length) {
    // The op disables at least one delegation the server does not hold as
    // still-enabled — not the batch this route derives. Refuse rather than
    // mark rows the signed op does not name.
    return {
      ok: false,
      reason: 'extra',
      expected: expectedIds.map((e) => e.hash),
      disabled: disabledHashes,
    }
  }
  return { ok: true, disabled: disabledHashes }
}
