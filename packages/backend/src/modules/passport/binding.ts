/**
 * L0 Agent Passport — address binding (#971, epic #970).
 *
 * The ONLY module allowed to interpret the passport's address fields, because
 * the encoding carries a sharp edge: EAS has no nullable field type, so an
 * agent with no smart account is attested with `smartAccount = address(0)`.
 *
 * Two rules follow, and both are enforced here rather than trusted to callers:
 *
 * 1. **A lookup by the zero address never resolves.** Otherwise every
 *    EOA-only agent would collide on one "address" and a merchant querying a
 *    junk/zero address would be handed somebody's passport. This is the same
 *    posture the delegation rail takes on the zero address (see
 *    `docs/security/delegation-rail-security-model.md` §7).
 * 2. **Either real address resolves to the SAME passport.** #946 made
 *    settlement a per-payment choice: a merchant sees the EOA on the EIP-3009
 *    leg and the smart account on erc7710 redemption. Verification must not
 *    depend on which path the payment happened to take.
 */

import { isAddress } from '@haven_ai/core'
import type { Address } from 'viem'

/** EAS's stand-in for "this agent has no smart account". */
export const NO_SMART_ACCOUNT = '0x0000000000000000000000000000000000000000' as const

/** The addresses a passport binds. `smartAccount` is null off the delegation rail. */
export interface PassportAddressBinding {
  /** `agents.delegate_address` — required, universal, the EIP-3009 `from`. */
  agentEoa: Address
  /** The Hybrid delegator — delegation rail only, the erc7710 delegator. */
  smartAccount: Address | null
}

/**
 * Build the binding from an agent's stored addresses.
 *
 * Throws on a missing or malformed EOA: an agent with no delegate address
 * cannot be given a passport at all, and attesting one with a junk address
 * would produce a credential that resolves to nothing.
 */
export function buildAddressBinding(input: {
  delegateAddress: string | null | undefined
  smartAccountAddress?: string | null
}): PassportAddressBinding {
  const { delegateAddress, smartAccountAddress } = input

  if (!isAddress(delegateAddress)) {
    throw new Error(
      'agent passport: delegate_address is required and must be a 40-hex address — ' +
        'an agent without one cannot be attested.',
    )
  }
  if (delegateAddress.toLowerCase() === NO_SMART_ACCOUNT) {
    throw new Error('agent passport: delegate_address must not be the zero address')
  }

  let smartAccount: Address | null = null
  if (smartAccountAddress != null && smartAccountAddress !== '') {
    if (!isAddress(smartAccountAddress)) {
      throw new Error('agent passport: smart account address is malformed')
    }
    // A zero smart account is the ENCODING for absent, never a real value —
    // accepting it as one would make an EOA-only agent look delegation-rail.
    if (smartAccountAddress.toLowerCase() !== NO_SMART_ACCOUNT) {
      smartAccount = smartAccountAddress as Address
    }
  }

  return { agentEoa: delegateAddress as Address, smartAccount }
}

/** Encode for the EAS payload — absent smart account becomes the zero address. */
export function encodeAddressBinding(binding: PassportAddressBinding): {
  agentEoa: Address
  smartAccount: Address
} {
  return {
    agentEoa: binding.agentEoa,
    smartAccount: binding.smartAccount ?? (NO_SMART_ACCOUNT as Address),
  }
}

/** Decode an on-chain payload back, mapping the zero sentinel to null. */
export function decodeAddressBinding(encoded: {
  agentEoa: string
  smartAccount: string
}): PassportAddressBinding {
  return buildAddressBinding({
    delegateAddress: encoded.agentEoa,
    smartAccountAddress:
      encoded.smartAccount.toLowerCase() === NO_SMART_ACCOUNT ? null : encoded.smartAccount,
  })
}

/**
 * Does `candidate` identify this passport?
 *
 * The verifier (#974) maps EITHER bound address to the same passport, so a
 * merchant gets the same answer whichever settlement path they saw. Returns
 * false for the zero address, malformed input, and any address the passport
 * does not bind — never throws, because this runs on merchant-supplied input.
 */
export function bindingMatches(binding: PassportAddressBinding, candidate: unknown): boolean {
  if (!isAddress(candidate)) return false
  const needle = candidate.toLowerCase()
  // Rule 1: the sentinel is not an identity. Checked BEFORE comparing, so an
  // EOA-only passport (smartAccount === null) can never be matched by it.
  if (needle === NO_SMART_ACCOUNT) return false
  if (binding.agentEoa.toLowerCase() === needle) return true
  return binding.smartAccount != null && binding.smartAccount.toLowerCase() === needle
}
