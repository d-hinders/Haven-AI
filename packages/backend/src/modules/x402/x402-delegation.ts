/**
 * x402 direct settlement on the delegation rail (#830, epic #821 Phase 4).
 *
 * The convergence the whole architecture was chosen for: the agent's budget
 * delegation is ALSO the settlement instrument. Per payment, the agent's
 * delegate account RE-DELEGATES a narrowed slice to the merchant:
 *
 *   treasury ──(budget delegation: period budget, recipient?, expiry)──▶ agent account
 *   agent account ──(child: EXACT amount, payee pin, short expiry)──▶ merchant/facilitator
 *
 * The merchant redeems the CHAIN [child, parent] via redeemDelegations: the
 * enforcers on BOTH hops run in the same settlement transaction, so the
 * period budget is consumed by the settlement itself — one meter, no funding
 * leg, no delegate hot balance, no sweep. (Epic #713's entire problem class
 * does not exist on this rail.)
 *
 * Non-custody split: this module BUILDS the unsigned child and ASSEMBLES the
 * payload after the agent has signed it client-side (EIP-712, domain = the
 *pinned manager; the delegate account validates via EIP-1271). Haven never
 * signs (#824 invariant 12; CI-enforced).
 *
 * Payload format = @metamask/x402's erc7710 option, proven end-to-end by the
 * #452 prototype and the demo merchant's `erc7710` rail (#750):
 * `{ delegationManager, permissionContext, delegator }`.
 */

import { hashTypedData, keccak256, pad, stringToBytes, type Address, type Hex } from 'viem'
import { Interface } from 'ethers'
import { createDelegation, type Delegation } from '@metamask/smart-accounts-kit'
import { encodeDelegations, hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { getDelegationContracts } from '../../rails/delegation-contracts.js'
import { getDelegationEnvironment, delegationSigningPayload } from '../../rails/delegation-policy.js'

const ERC20_IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

/** Cap on how long a settlement grant may live, whatever the merchant asks. */
export const MAX_SETTLEMENT_WINDOW_SECONDS = 600 // the #715 discipline carries over

/**
 * Domain-separated salt that makes a settlement child INTENT-UNIQUE (#2094).
 *
 * ## The defect it fixes
 *
 * Until #2094 the child was built with the kit's default salt (`0x00`,
 * verified by probe), and its only clock-derived field was the `timestamp`
 * caveat's `beforeThreshold`. Two authorizations sharing merchant `payTo`,
 * token, amount and expiry SECOND therefore produced a BYTE-IDENTICAL child
 * with the same `childHash`: nothing on-chain distinguished two of a user's
 * own look-alike open payments, so a verified settlement could be attached to
 * either one. #2096 answered that by refusing to guess (the ambiguity guard in
 * `CONFIRM_SETTLEMENT_OBSERVED_SQL`) — safe, but both payments then miss the
 * books.
 *
 * ## Why the INTENT ID, and why hashed
 *
 * The salt must be **derived**, never random: the completion seam — and the
 * passive settlement sweeper #2117 wants — has to RECOMPUTE the expected child
 * for a stored intent rather than trust an opaque column. The payment intent's
 * `id` is the only value that is (a) unique per intent by primary key, (b)
 * already stored on the row the verifier starts from, and (c) fixed before the
 * child exists. So the mapping intent → child is a pure function of the intent
 * row, reproducible by anyone holding it.
 *
 * It is HASHED rather than used raw for shape, not secrecy: `createDelegation`
 * wants a 32-byte salt and a UUID is 16, and the `haven-x402-settlement:`
 * domain tag makes it structurally impossible for a settlement salt to collide
 * with a budget-delegation salt (`delegationSalt`, `rails/delegation-policy.ts`,
 * whose tag is `haven-delegation:`).
 *
 * ## On-chain leak assessment
 *
 * The salt is PUBLIC — it travels in the child and is emitted verbatim in the
 * DelegationManager's `RedeemedDelegation` log. It leaks nothing:
 *
 * - The preimage is a domain tag plus a v4 UUID: 122 bits of CSPRNG entropy
 *   with no user, agent, merchant, amount or timing information encoded in it.
 * - That UUID is not a Haven secret either — it is the `payment_id` already
 *   returned to the agent in the authorize response, quoted in the settle URL
 *   and shown in the dashboard. Nothing is authorized by knowing it.
 * - Because it is hashed, the id is not even legible on-chain; recovering it
 *   would mean inverting keccak over a 122-bit-random preimage. Correlating
 *   two settlements as "the same user's" is likewise no easier than before —
 *   the payer smart account is already in the `Transfer` log's `from`.
 *
 * Both directions are what we want: opaque to an observer, recomputable by
 * anyone who legitimately holds the intent row.
 */
export function settlementSalt(intentId: string): Hex {
  return keccak256(stringToBytes(`haven-x402-settlement:${intentId}`))
}

export interface X402SettlementRequest {
  chainId: number
  /**
   * The payment intent this child settles. #2094: the ONLY source of the
   * child's uniqueness — the caller generates the intent id BEFORE building
   * (see `delegation-authorize.ts`) so that the child and the row that stores
   * it are one thing.
   */
  intentId: string
  /** The agent's delegate account — the child's delegator. */
  delegateAccountAddress: Address
  /** The SIGNED budget delegation (the parent) as stored by #828. */
  budgetDelegation: Delegation
  asset: Address
  /** Exact atomic amount from the 402 requirements. */
  amountAtomic: bigint
  /** The merchant's receiving address (payTo). */
  payTo: Address
  /** Merchant-requested window; clamped to MAX_SETTLEMENT_WINDOW_SECONDS. */
  maxTimeoutSeconds: number
  /** Facilitator/redeemer addresses from requirements.extra, when present. */
  redeemers?: Address[]
}

export interface BuiltSettlementDelegation {
  child: Omit<Delegation, 'signature'>
  childHash: Hex
  /** EIP-712 payload the AGENT signs client-side. */
  signingPayload: ReturnType<typeof delegationSigningPayload>
  expiresAt: number
}

/**
 * The narrowed per-payment child delegation. Caveats mirror the recipe the
 * kit's own x402 provider enforces (exact amount + payee pin + expiry +
 * redeemer when known) — but built UNSIGNED, for the client to sign.
 */
export function buildSettlementDelegation(req: X402SettlementRequest): BuiltSettlementDelegation {
  if (req.amountAtomic <= 0n) throw new Error('settlement amount must be positive')
  // #2094: refuse to build an un-attributable child rather than quietly fall
  // back to the constant salt. An empty intent id would reintroduce the exact
  // byte-identical-child defect this parameter exists to remove, and it would
  // do so silently — on a money path whose failure mode is a wrong row in
  // someone's books.
  if (!req.intentId) throw new Error('settlement intent id is required to salt the child delegation')
  const env = getDelegationEnvironment(req.chainId)
  const nowSec = Math.floor(Date.now() / 1000)
  const windowSec = Math.min(Math.max(req.maxTimeoutSeconds, 60), MAX_SETTLEMENT_WINDOW_SECONDS)
  const expiresAt = nowSec + windowSec

  const caveats: Array<Record<string, unknown>> = [
    // Pin the transfer's `to` word — the merchant can settle only to payTo.
    { type: 'allowedCalldata', startIndex: 4, value: pad(req.payTo.toLowerCase() as Hex, { size: 32 }) },
    { type: 'timestamp', afterThreshold: 0, beforeThreshold: expiresAt },
  ]
  if (req.redeemers && req.redeemers.length > 0) {
    caveats.push({ type: 'redeemer', redeemers: req.redeemers })
  }

  const child = createDelegation({
    environment: env,
    from: req.delegateAccountAddress,
    // ANY_BENEFICIARY unconditionally — the redeemer CAVEAT does the
    // constraining when `req.redeemers` is set. Pinning `to` to
    // `redeemers[0]` (the previous code) contradicted a multi-entry caveat:
    // the grant would silently fail for every facilitator but the first
    // (#1053 review, finding 2).
    //
    // #1058: `req.redeemers` is populated when the client forwards the
    // 402's `extra.facilitatorAddresses` (MetaMask's erc7710 shape) into
    // authorize — the child is then redeemable ONLY by those addresses.
    // When a merchant advertises no facilitators there is nothing to pin
    // and the child remains a bearer instrument within its bounds (exact
    // amount, payee-pinned, ≤600s expiry) — exposure ceiling "merchant
    // gets paid without delivering", never fund loss (#1053 finding 1).
    to: '0x0000000000000000000000000000000000000a11' as Address, // ANY_BENEFICIARY
    parentDelegation: req.budgetDelegation,
    scope: {
      type: 'erc20TransferAmount',
      tokenAddress: req.asset,
      maxAmount: req.amountAtomic,
    },
    caveats: caveats as never,
    // #2094: the intent-unique salt. Without it two authorizations sharing
    // merchant/token/amount/expiry-second hash to the same child and no
    // settlement of either can be attributed to one rather than the other.
    salt: settlementSalt(req.intentId),
  })
  const childHash = hashDelegation({ ...child, signature: '0x' } as Delegation)
  return {
    child,
    childHash,
    signingPayload: delegationSigningPayload(child, req.chainId),
    expiresAt,
  }
}

export interface X402Erc7710Payload {
  delegationManager: Address
  permissionContext: Hex
  delegator: Address
}

/**
 * Assemble the X-PAYMENT payload once the agent has signed the child. The
 * permission context is the encoded CHAIN — child first, then the budget
 * delegation whose enforcers meter the spend.
 */
export function assembleSettlementPayload(
  chainId: number,
  child: Omit<Delegation, 'signature'>,
  childSignature: Hex,
  budgetDelegation: Delegation,
  delegateAccountAddress: Address,
): X402Erc7710Payload {
  const signedChild: Delegation = { ...child, signature: childSignature } as Delegation
  return {
    delegationManager: getDelegationContracts(chainId).delegationManager,
    permissionContext: encodeDelegations([signedChild, budgetDelegation]),
    delegator: delegateAccountAddress,
  }
}

/** The requirements entry the payer chose — echoed back per x402 v2. */
export interface X402AcceptedEcho {
  amount: string
  payTo: Address
  asset: Address
  maxTimeoutSeconds: number
  /**
   * #1058: echoed VERBATIM from the merchant's advertised entry when present.
   * @x402/core's v2 matcher requires the advertised `extra` to be a SUBSET of
   * this echo (`objectContainsSubset`) — a facilitator-advertising merchant
   * rejects any header that omits these.
   */
  facilitatorAddresses?: string[]
}

/**
 * The base64 X-PAYMENT header for an exact-scheme erc7710 payment.
 *
 * x402 v2 shape: the payer ECHOES the accepted requirements entry (`accepted`)
 * alongside the scheme payload — merchants built on @x402/core v2 match it
 * field-for-field (scheme/network/amount/payTo/asset/maxTimeoutSeconds +
 * extra.assetTransferMethod) before touching the chain. The v1 shape
 * (payload only) made every v2 merchant reject with a generic failure —
 * caught by the #1064 QA leg's first live run.
 */
export function encodeXPaymentHeader(
  network: string,
  payload: X402Erc7710Payload,
  accepted: X402AcceptedEcho,
): string {
  const body = {
    x402Version: 2,
    scheme: 'exact',
    network,
    accepted: {
      scheme: 'exact',
      network,
      amount: accepted.amount,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      asset: accepted.asset,
      extra: {
        assetTransferMethod: 'erc7710',
        ...(accepted.facilitatorAddresses && accepted.facilitatorAddresses.length > 0
          ? { facilitatorAddresses: accepted.facilitatorAddresses }
          : {}),
      },
    },
    payload,
  }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}

/** Sanity guard used by the route: the transfer the child permits, decoded. */
export function settlementTransferCalldata(payTo: Address, amountAtomic: bigint): Hex {
  return ERC20_IFACE.encodeFunctionData('transfer', [payTo, amountAtomic]) as Hex
}

/**
 * EIP-712 digest of the payload the account actually validates (#1138).
 *
 * On the delegation rail `payloadHash` is the bare ERC-4337 UserOp hash, which
 * the account does NOT validate — so binding it alone tells the edge signer
 * nothing about the typed data it is being asked to sign. Committing to this
 * digest inside the Haven-signed expected context is what keeps the signer's
 * verify-then-sign property intact on this rail.
 *
 * Lives here rather than in the route because the chain SDKs belong behind the
 * lib boundary (`chain-sdk-not-in-routes`).
 */
export function typedDataDigest(typedData: unknown): string | undefined {
  if (!typedData || typeof typedData !== 'object') return undefined
  try {
    return hashTypedData(typedData as Parameters<typeof hashTypedData>[0])
  } catch (err) {
    // Unhashable typed data is a backend defect, not a client error, and it is
    // not survivable: the edge signer re-derives this same digest and would
    // refuse the payload anyway. Fail here with a message that says so, rather
    // than letting a raw viem type error surface as an opaque 500.
    throw new Error(
      'Failed to hash the delegation-rail signing payload for the x402 expected context. ' +
        'sign_data.typed_data must be a complete EIP-712 payload (domain, types, primaryType, message). ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
