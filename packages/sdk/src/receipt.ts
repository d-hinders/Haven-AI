import { ethers } from 'ethers'
import { concatHex, encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem'
import { DELEGATION_MANAGER } from './settlement-child.js'
import type { RawPaymentParties } from './types.js'

/**
 * Verifiable payment receipts.
 *
 * A self-contained bundle for a settled Haven payment whose agent
 * authorisation can be checked offline. What `verifyPaymentReceipt` proves is
 * deliberately narrow: the `payment` block (amount, recipient) is
 * Haven-asserted and is NOT bound by the signature, and `verified: true` never
 * proves the payment settled on-chain — settlement stays an explorer check on
 * `onChain.txHash` / `settlementTxHash`.
 *
 * What `verified: true` means, per scheme:
 *
 * - erc7710 (`authorization.signatureScheme: 'eip712_delegation'`): the bundle
 *   carries the settlement child's EIP-712 struct hash as `signHash`. The
 *   verifier rebuilds the digest the delegate actually signed —
 *   `keccak256(0x1901 ‖ domainSeparator(DelegationManager, chainId) ‖ signHash)`
 *   — from the DelegationManager address the SDK pins and the bundle's
 *   `onChain.chainId`, never from a value the receipt itself vouches for.
 *   `verified: true` means the delegate key signed that settlement delegation
 *   (`verifiedOver: 'delegation_digest'`).
 * - direct payments and the eip3009 funding leg
 *   (`signatureScheme: 'eip712_userop'`) sign an ERC-4337 user operation the
 *   bundle does not carry: they return `not_verifiable_offline` rather than a
 *   false accusation.
 * - retired-rail bundles (no scheme) carry a raw-signed `signHash`; the
 *   verifier recovers over it directly, then over the delegation digest when
 *   the chain allows rebuilding it.
 *
 * Anything that is not a signed bundle — including a `haven_list_receipts`
 * history row, which carries no signature at all — returns
 * `not_a_signed_receipt`. Verification never throws.
 *
 * #3723: the response `GET /payments/{id}/receipt` returns —
 * `{ receipt, verification }` — is accepted AS-IS: when the top level carries
 * no `authorization`, the `.receipt` object inside is verified instead (one
 * level, no recursion). The wrapper's `verification` is never read — it is
 * Haven's own self-check, and trusting it would defeat an offline verifier.
 *
 * This lives in the SDK so agents and users can verify receipts client-side.
 */
export const RECEIPT_VERSION = 'haven-receipt-1'

export interface PaymentReceipt {
  version: typeof RECEIPT_VERSION
  paymentId: string
  payment: {
    token: string
    tokenAddress: string
    amount: string
    amountSek: string | null
    recipient: string
    /** The payer's smart-account address. */
    account: string
    /**
     * #2960: one party vocabulary for "who paid", additive alongside `account`
     * above (which is `parties.treasury_account` only). Optional: a server
     * from before #2960 emits neither. Ignored by `verifyPaymentReceipt`,
     * which reads only `authorization`.
     */
    parties?: RawPaymentParties
    chainId: number
    settledAt: string | null
    resourceUrl: string | null
    /**
     * #3770: the paying agent's own evidence-only verdict on what the
     * merchant DELIVERED (`ok` / `unusable` / `partial`, plus a bounded
     * note). Additive and OPTIONAL: a server from before #3770 emits
     * neither, and `null` means the agent has not reported. Ignored by
     * `verifyPaymentReceipt`, which reads only `authorization` — the same
     * rule `parties` follows. Evidence only: it never changes what the
     * payment itself is, and `settled`/amounts are untouched by a report.
     */
    deliveryQuality?: {
      quality: 'ok' | 'unusable' | 'partial'
      note: string | null
      reportedAt: string | null
    } | null
  }
  /** The agent's cryptographic authorisation — what makes the receipt verifiable. */
  authorization: {
    delegate: string
    signHash: string
    signature: string | null
    /**
     * #3418: which digest the delegate signed — selects what offline
     * verification rebuilds. `'eip712_delegation'`: the settlement
     * delegation's EIP-712 digest (erc7710). `'eip712_userop'`: an ERC-4337
     * user-operation digest the bundle does not carry (direct payments, the
     * eip3009 funding leg) — not verifiable offline. Absent on retired-rail
     * bundles and on backends older than #3418, whose `signHash` was signed
     * raw. The value is only a selector: a lying one cannot make a forged
     * signature verify, because recovery must still return `delegate`.
     */
    signatureScheme?: 'eip712_delegation' | 'eip712_userop'
  }
  onChain: {
    txHash: string | null
    chainId: number
  }
}

export type ReceiptVerification =
  | { verified: true; recoveredSigner: string; verifiedOver: 'sign_hash' | 'delegation_digest' }
  | {
      verified: false
      reason:
        /** #3418: the input is not a haven-receipt-1 bundle (a haven_list_receipts row, null, undefined, a non-object). */
        | 'not_a_signed_receipt'
        /** #3418: eip712_userop bundle; or a delegation bundle on a chain the SDK pins no DelegationManager for. */
        | 'not_verifiable_offline'
        | 'missing_signature'
        | 'bad_signature'
        | 'signer_mismatch'
      recoveredSigner?: string
    }

/** Chains whose DelegationManager the SDK pins (same address on both — rails/delegation-contracts.ts). */
const DELEGATION_MANAGER_CHAIN_IDS: ReadonlySet<number> = new Set([8453, 84532])

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
)

/**
 * The EIP-712 domain separator of the DelegationManager on `chainId`, rebuilt
 * from the manager's own constants (name/version, fixed in the contract) and
 * the address the SDK pins — never from a value the receipt vouches for.
 */
function delegationDomainSeparator(chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes('DelegationManager')),
        keccak256(toBytes('1')),
        BigInt(chainId),
        DELEGATION_MANAGER as Hex,
      ],
    ),
  )
}

/** The EIP-712 digest over a delegation struct hash (what the delegate signs). */
function delegationDigest(structHash: string, chainId: number): Hex {
  return keccak256(concatHex(['0x1901', delegationDomainSeparator(chainId), structHash as Hex]))
}

/** Default ECDSA recovery (raw ecrecover over the hash, no message prefix). */
function defaultRecover(hash: string, signature: string): string {
  return ethers.recoverAddress(hash, signature)
}

const NOT_A_SIGNED_RECEIPT = { verified: false, reason: 'not_a_signed_receipt' } as const

type RecoverFn = (hash: string, signature: string) => string

type MatchResult =
  | { ok: true; recoveredSigner: string }
  | { ok: false; reason: 'bad_signature' | 'signer_mismatch'; recoveredSigner?: string }

/** Recover over one candidate hash and compare the signer with the named delegate. */
function match(delegate: string, hash: string, signature: string, recover: RecoverFn): MatchResult {
  let recovered: string
  try {
    recovered = recover(hash, signature)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (recovered.toLowerCase() !== delegate.toLowerCase()) {
    return { ok: false, reason: 'signer_mismatch', recoveredSigner: recovered }
  }
  return { ok: true, recoveredSigner: recovered }
}

function finish(result: MatchResult, verifiedOver: 'sign_hash' | 'delegation_digest'): ReceiptVerification {
  if (result.ok) {
    return { verified: true, recoveredSigner: result.recoveredSigner, verifiedOver }
  }
  return result.recoveredSigner !== undefined
    ? { verified: false, reason: result.reason, recoveredSigner: result.recoveredSigner }
    : { verified: false, reason: result.reason }
}

/**
 * Verify a receipt's agent authorisation offline: recover the signer and
 * confirm it is the agent delegate, over whichever digest the bundle's scheme
 * names (see the module doc for what that proves — and what it does not).
 * Never throws: anything that is not a signed receipt — a
 * `haven_list_receipts` history row, null, undefined, a non-object — returns
 * `not_a_signed_receipt`. The `{ receipt, verification }` wrapper the receipt
 * endpoint returns is accepted as-is: `.receipt` is verified, and the
 * wrapper's `verification` — Haven's own self-check — is never read. Pure —
 * `recover` is injectable but defaults to
 * standard ECDSA recovery, so this runs anywhere (no Haven backend).
 */
export function verifyPaymentReceipt(
  receipt: unknown,
  recover: RecoverFn = defaultRecover,
): ReceiptVerification {
  // #3418 rule 1: a list row (or any non-bundle) has no authorization object
  // holding string delegate/signHash — answer, never throw.
  if (typeof receipt !== 'object' || receipt === null) return NOT_A_SIGNED_RECEIPT
  let source = receipt as {
    authorization?: unknown
    receipt?: unknown
    onChain?: { chainId?: unknown }
  }
  // #3723: accept the endpoint's response as-is. When the top level carries no
  // `authorization` and `.receipt` is a non-null object, verify the bundle
  // inside the `{ receipt, verification }` wrapper (GET
  // /payments/{id}/receipt, and HavenClient.getReceipt's re-wrap). ONE level
  // only — no recursion — and the wrapper's `verification` is NEVER read: it
  // is Haven's own self-check, and trusting it would defeat an offline
  // verifier. A list row wrapped or bare still answers not_a_signed_receipt.
  if (typeof source.authorization !== 'object' || source.authorization === null) {
    if (typeof source.receipt !== 'object' || source.receipt === null) {
      return NOT_A_SIGNED_RECEIPT
    }
    source = source.receipt as typeof source
  }
  if (typeof source.authorization !== 'object' || source.authorization === null) {
    return NOT_A_SIGNED_RECEIPT
  }
  const auth = source.authorization as {
    delegate?: unknown
    signHash?: unknown
    signature?: unknown
    signatureScheme?: unknown
  }
  const { delegate, signHash, signature, signatureScheme } = auth
  if (typeof delegate !== 'string' || delegate === '' || typeof signHash !== 'string' || signHash === '') {
    return NOT_A_SIGNED_RECEIPT
  }
  if (typeof signature !== 'string' || signature === '') {
    return { verified: false, reason: 'missing_signature' }
  }

  const chainId =
    typeof source.onChain?.chainId === 'number' ? source.onChain.chainId : undefined
  const digestVerifiable = chainId !== undefined && DELEGATION_MANAGER_CHAIN_IDS.has(chainId)

  // #3418 rule 4: a userop digest needs the full UserOperation, which the
  // bundle does not carry. Return not_verifiable_offline — never
  // signer_mismatch, which would accuse a genuine payment.
  if (signatureScheme === 'eip712_userop') {
    return { verified: false, reason: 'not_verifiable_offline' }
  }

  // #3418 rule 3: rebuild the delegation digest from the pinned manager and
  // the bundle's chain id, then recover over it.
  if (signatureScheme === 'eip712_delegation') {
    if (!digestVerifiable) {
      return { verified: false, reason: 'not_verifiable_offline' }
    }
    let digest: string
    try {
      digest = delegationDigest(signHash, chainId as number)
    } catch {
      return { verified: false, reason: 'bad_signature' }
    }
    return finish(match(delegate, digest, signature, recover), 'delegation_digest')
  }

  // #3418 rule 5: absent or unknown scheme — retired-rail history (signed raw
  // over signHash) or a backend older than this change. Raw recovery first,
  // then the delegation digest when the chain allows rebuilding it. This is
  // the one remaining ambiguous case, limited to old bundles.
  const raw = match(delegate, signHash, signature, recover)
  if (raw.ok) return finish(raw, 'sign_hash')
  if (digestVerifiable) {
    let digest: string
    try {
      digest = delegationDigest(signHash, chainId as number)
    } catch {
      return finish(raw, 'sign_hash')
    }
    const delegated = match(delegate, digest, signature, recover)
    if (delegated.ok) return finish(delegated, 'delegation_digest')
  }
  return finish(raw, 'sign_hash')
}
