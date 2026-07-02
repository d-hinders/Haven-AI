/**
 * Express Haven's policy shape as a Smart Sessions session (foundation #739,
 * ADR #719 Stage 2). Backend port of the pilot's `session-policies.ts`, which
 * was proven on Base Sepolia by the six-case enforcement suite (#722). Pure
 * construction — no network, no signing — so it is unit-testable and Haven
 * never holds a key: the built session is enabled by an owner-signed action and
 * signed at use time by the agent's session key (EIP-191, see #741).
 *
 * How each Haven policy maps:
 *
 * | Haven policy               | Smart Sessions expression                      |
 * |----------------------------|------------------------------------------------|
 * | recipient allowlist        | UniversalActionPolicy ParamRule: EQUAL on the  |
 * |                            | `to` param of USDC.transfer (offset 0)         |
 * | per-tx cap                 | ParamRule: LESS_THAN_OR_EQUAL on `amount`      |
 * |                            | (offset 32)                                    |
 * | cumulative spending limit  | same rule with `isLimited` + usage.limit —     |
 * |                            | the policy sums `amount` across uses           |
 * | time bound / expiry        | TimeFramePolicy as a userOp policy             |
 * | revoke (kill switch)       | owner tx: getRemoveSessionAction(permissionId) |
 *
 * Honest gaps carried from the pilot (surfaced, not hidden):
 * - **No native refill.** Haven's reset-period (allowance refills every N min)
 *   has no direct policy — usage.limit is a lifetime cumulative for the
 *   session. The refill parity mechanism is session rotation, gate #734.
 * - **Single recipient per session.** ParamRules AND together, so one session
 *   expresses ONE allowed recipient. An N-address allowlist needs N sessions.
 *   Today's agent model has no recipient allowlist at all (see CLAUDE.md), so
 *   supplying `allowedRecipient` is where the session rail *adds* capability;
 *   wiring it to a stored policy field is the routing slice (#745) / a product
 *   decision, deliberately not invented here.
 */

import {
  OWNABLE_VALIDATOR_ADDRESS,
  SmartSessionMode,
  encodeValidationData,
  getEnableSessionsAction,
  getPermissionId,
  getRemoveSessionAction,
  getTimeFramePolicy,
  getUniversalActionPolicy,
  type ActionData,
  type Session,
} from '@rhinestone/module-sdk'
import { pad, toFunctionSelector, type Address, type Hex } from 'viem'

export { SmartSessionMode, getEnableSessionsAction, getPermissionId, getRemoveSessionAction }

export const USDC_TRANSFER_SELECTOR = toFunctionSelector('function transfer(address,uint256)')

/** UniversalActionPolicy reads calldata after the selector: byte offsets. */
const OFFSET_PARAM0_TO = 0n
const OFFSET_PARAM1_AMOUNT = 32n

// Mirrors module-sdk's ParamCondition enum (not re-exported from the package
// root). ABI-level uint8 values — stable by construction.
const CONDITION_EQUAL = 0
const CONDITION_LESS_THAN_OR_EQUAL = 4

const ZERO_RULE = {
  condition: CONDITION_EQUAL,
  offset: 0n,
  isLimited: false,
  ref: pad('0x', { size: 32 }) as Hex,
  usage: { limit: 0n, used: 0n },
}

type Rules16 = Parameters<typeof getUniversalActionPolicy>[0]['paramRules']['rules']

/** The ABI shape demands a fixed 16-tuple; `length` tells the policy how many count. */
function padRules(rules: (typeof ZERO_RULE)[]): Rules16 {
  if (rules.length > 16) throw new Error('UniversalActionPolicy supports at most 16 rules')
  return Array.from({ length: 16 }, (_, i) => rules[i] ?? ZERO_RULE) as Rules16
}

export interface HavenPolicySessionArgs {
  /** The agent's session key (today's "delegate", now policy-bound). */
  sessionKeyAddress: Address
  usdcAddress: Address
  /** The single allowlisted recipient (see gaps: one per session). */
  allowedRecipient: Address
  /** Max USDC (atomic) per transfer. */
  perTxCapAtomic: bigint
  /** Lifetime cumulative USDC (atomic) for the session (no native refill — see gaps). */
  cumulativeLimitAtomic: bigint
  /** Unix seconds. Session is unusable outside [validAfter, validUntil]. */
  validUntilSec: number
  validAfterSec?: number
  /** Unique per session — vary to create parallel/replacement sessions. */
  salt: Hex
  chainId: bigint
}

/** Build the Session expressing Haven's policy shape for USDC transfers. */
export function buildHavenPolicySession(args: HavenPolicySessionArgs): Session {
  const recipientRule = {
    condition: CONDITION_EQUAL,
    offset: OFFSET_PARAM0_TO,
    isLimited: false,
    ref: pad(args.allowedRecipient, { size: 32 }) as Hex,
    usage: { limit: 0n, used: 0n },
  }
  const amountRule = {
    condition: CONDITION_LESS_THAN_OR_EQUAL,
    offset: OFFSET_PARAM1_AMOUNT,
    isLimited: true,
    ref: pad(`0x${args.perTxCapAtomic.toString(16)}`, { size: 32 }) as Hex,
    usage: { limit: args.cumulativeLimitAtomic, used: 0n },
  }

  const usdcTransferAction: ActionData = {
    actionTarget: args.usdcAddress,
    actionTargetSelector: USDC_TRANSFER_SELECTOR,
    actionPolicies: [
      getUniversalActionPolicy({
        valueLimitPerUse: 0n, // no native value rides along with an ERC-20 transfer
        paramRules: { length: 2n, rules: padRules([recipientRule, amountRule]) },
      }),
    ],
  }

  return {
    sessionValidator: OWNABLE_VALIDATOR_ADDRESS,
    sessionValidatorInitData: encodeValidationData({
      threshold: 1,
      owners: [args.sessionKeyAddress],
    }),
    salt: args.salt,
    userOpPolicies: [
      getTimeFramePolicy({
        validUntil: args.validUntilSec,
        validAfter: args.validAfterSec ?? 0,
      }),
    ],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [usdcTransferAction],
    // Sponsored UserOps (paymaster) must be explicitly permitted, or every
    // sponsored payment fails validation.
    permitERC4337Paymaster: true,
    chainId: args.chainId,
  }
}
