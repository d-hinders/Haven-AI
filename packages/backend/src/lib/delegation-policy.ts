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
import { recoverTypedDataAddress, pad, type Address, type Hex } from 'viem'
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
