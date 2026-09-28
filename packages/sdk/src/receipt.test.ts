import { describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import { hashStruct, hashTypedData, type Hex } from 'viem'
import { hashDelegation, SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils'
import {
  verifyPaymentReceipt,
  RECEIPT_VERSION,
  type PaymentReceipt,
} from './receipt.js'
import { mapPaymentReceipt } from './payment-mappers.js'
import { DELEGATION_MANAGER } from './settlement-child.js'

const DELEGATE = new Wallet(`0x${'11'.repeat(32)}`)
const SIGN_HASH = `0x${'ab'.repeat(32)}`

function receipt(over: Partial<PaymentReceipt['authorization']> = {}): PaymentReceipt {
  return {
    version: RECEIPT_VERSION,
    paymentId: 'pi1',
    payment: {
      token: 'xDAI',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '1',
      amountSek: '10.60',
      recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      account: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chainId: 100,
      settledAt: '2026-06-20T10:00:00.000Z',
      resourceUrl: 'https://api.example/resource',
    },
    authorization: { delegate: DELEGATE.address, signHash: SIGN_HASH, signature: null, ...over },
    onChain: { txHash: `0x${'cd'.repeat(32)}`, chainId: 100 },
  }
}

describe('verifyPaymentReceipt (client-side, no Haven trust)', () => {
  it('verifies a receipt whose signature recovers to the delegate', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const result = verifyPaymentReceipt(receipt({ signature }))
    expect(result.verified).toBe(true)
    if (result.verified) expect(result.recoveredSigner.toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it('rejects a receipt with no signature', () => {
    expect(verifyPaymentReceipt(receipt({ signature: null }))).toMatchObject({
      verified: false,
      reason: 'missing_signature',
    })
  })

  it('rejects a signature that recovers to a non-delegate address', () => {
    const other = new Wallet(`0x${'22'.repeat(32)}`)
    const signature = other.signingKey.sign(SIGN_HASH).serialized
    expect(verifyPaymentReceipt(receipt({ signature }))).toMatchObject({
      verified: false,
      reason: 'signer_mismatch',
    })
  })

  it('rejects a malformed signature', () => {
    expect(verifyPaymentReceipt(receipt({ signature: '0xnope' }))).toMatchObject({
      verified: false,
      reason: 'bad_signature',
    })
  })

  it('uses the default recover when none is injected (runs with no deps wired)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    expect(verifyPaymentReceipt(receipt({ signature })).verified).toBe(true)
  })

  // #2960: `payment.parties` is additive and NEVER read by verification —
  // it recovers the signer from `authorization` only.
  it('verifies identically whether or not payment.parties is present, and ignores wrong values in it', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const withoutParties = receipt({ signature })
    const withParties: PaymentReceipt = {
      ...withoutParties,
      payment: {
        ...withoutParties.payment,
        parties: {
          // Deliberately garbage — if verification read this, it would not
          // recover to DELEGATE.address and the assertion below would fail.
          treasury_account: '0x0000000000000000000000000000000000dEaD',
          delegate: '0x0000000000000000000000000000000000dEaD',
          delegate_account: null,
          merchant: null,
        },
      },
    }
    const withoutResult = verifyPaymentReceipt(withoutParties)
    const withResult = verifyPaymentReceipt(withParties)
    expect(withResult).toEqual(withoutResult)
    expect(withResult.verified).toBe(true)
  })
})

// ── #3418: never throws, verifies the live-rail schemes ──────────────────────

// A real erc7710 settlement child's `signHash` is the child's STRUCT hash —
// `hashDelegation(child)` (routes/payments.ts stores `built.childHash`) —
// while the delegate signs the full EIP-712 DIGEST over the kit's
// `SIGNABLE_DELEGATION_TYPED_DATA` for the DelegationManager domain. Both
// halves here come from the kit/backend's own machinery: `hashDelegation` for
// the stored hash, viem `hashTypedData` + the kit's signable schema for the
// digest — deliberately NOT the verifier's own helper, so a verifier that
// recovers over the raw struct hash (today's bug) fails this test.
const BASE_SEPOLIA = 84532
const BASE_MAINNET = 8453
const DELEGATE_7710 = new Wallet(`0x${'33'.repeat(32)}`)
const OTHER_7710 = new Wallet(`0x${'44'.repeat(32)}`)

const SETTLEMENT_CHILD: {
  delegator: Hex
  delegate: Hex
  authority: Hex
  caveats: { enforcer: Hex; terms: Hex }[]
  salt: Hex
  signature: Hex
} = {
  delegator: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  delegate: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  authority: `0x${'00'.repeat(32)}`,
  caveats: [
    {
      enforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc',
      terms: ('0x' + 'cd'.repeat(32)) as Hex,
    },
  ],
  salt: `0x${'ab'.repeat(32)}`,
  signature: '0x',
}

/** The struct hash the backend stores as `sign_hash` (built.childHash). */
const CHILD_STRUCT_HASH = hashDelegation({ ...SETTLEMENT_CHILD } as never) as Hex

/**
 * The digest the delegate signs (rails/delegation-policy.ts
 * `delegationSigningPayload` + viem `recoverTypedDataAddress` at settle) —
 * the struct hash of the kit's SIGNABLE schema over the DM domain separator.
 */
function erc7710Digest(chainId: number): Hex {
  return hashTypedData({
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId,
      verifyingContract: DELEGATION_MANAGER,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: 'Delegation',
    message: {
      delegate: SETTLEMENT_CHILD.delegate,
      delegator: SETTLEMENT_CHILD.delegator,
      authority: SETTLEMENT_CHILD.authority,
      caveats: SETTLEMENT_CHILD.caveats,
      salt: BigInt(SETTLEMENT_CHILD.salt),
    },
  })
}

function erc7710Receipt(over: {
  signHash?: string
  signature?: string | null
  chainId?: number
  signatureScheme?: 'eip712_delegation' | 'eip712_userop'
}): PaymentReceipt {
  return {
    ...receipt(),
    authorization: {
      delegate: DELEGATE_7710.address,
      signHash: over.signHash ?? CHILD_STRUCT_HASH,
      signature:
        over.signature === undefined
          ? DELEGATE_7710.signingKey.sign(erc7710Digest(BASE_SEPOLIA)).serialized
          : over.signature,
      ...(over.signatureScheme === undefined ? {} : { signatureScheme: over.signatureScheme }),
    },
    onChain: {
      txHash: `0x${'cd'.repeat(32)}`,
      chainId: over.chainId ?? BASE_SEPOLIA,
    },
  }
}

// Cross-check the two trusted halves compose the way the backend's own
// recovery does: struct hash of the signable schema + 0x1901 + DM domain.
it('kit struct hash + viem digest compose to the delegation digest scheme', () => {
  const structHash = hashStruct({
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: 'Delegation',
    // caveats/salt normalized exactly as toDelegationStruct does
    data: {
      delegate: SETTLEMENT_CHILD.delegate,
      delegator: SETTLEMENT_CHILD.delegator,
      authority: SETTLEMENT_CHILD.authority,
      caveats: SETTLEMENT_CHILD.caveats,
      salt: BigInt(SETTLEMENT_CHILD.salt),
    },
  })
  expect(structHash).toBe(CHILD_STRUCT_HASH)
})

describe('verifyPaymentReceipt #3418 — never throws on a non-bundle', () => {
  // (a) A `haven_list_receipts` row is NOT a signed bundle: the mapper names
  // every key it emits and `authorization` is not one of them, on any rail.
  it('returns not_a_signed_receipt for a real mapPaymentReceipt erc7710 row', () => {
    const row = mapPaymentReceipt({
      id: '50dec266-a3a5-4e5b-a8ef-8b2f3ad4c111',
      payment_id: 'aa9ece55-9b0c-4f4d-a6b7-1c2d3e4f5a6b',
      rail: 'x402',
      proof_status: 'protocol_receipt_attached',
      tx_hash: null,
      funding_tx_hash: null,
      settlement_tx_hash: '0xsettlement',
      chain_id: BASE_SEPOLIA,
      resource_url: 'https://merchant.example/resource',
      merchant_address: '0x00000000000000000000000000000000000000aa',
      payer_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      settlement_address: '0x00000000000000000000000000000000000000bb',
      token_symbol: 'USDC',
      token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount_raw: '1000000',
      amount_human: '1.00',
      challenge_id: null,
      idempotency_key: null,
      challenge_payload: null,
      selected_payment: null,
      payment_proof_header_name: null,
      protocol_receipt_header_name: 'PAYMENT-RESPONSE',
      protocol_receipt_payload: '{}',
      merchant_status: null,
      confirmed_at: '2026-09-28T10:00:00.000Z',
      created_at: '2026-09-28T10:00:00.000Z',
      updated_at: '2026-09-28T10:00:00.000Z',
    } as never)
    expect((row as { authorization?: unknown }).authorization).toBeUndefined()
    expect(() => verifyPaymentReceipt(row)).not.toThrow()
    expect(verifyPaymentReceipt(row)).toEqual({
      verified: false,
      reason: 'not_a_signed_receipt',
    })
  })

  it('returns not_a_signed_receipt for an eip3009-shaped row, null, undefined and non-objects', () => {
    const eip3009Row = mapPaymentReceipt({
      id: 'e3009-1',
      payment_id: 'e3009-p',
      rail: 'x402',
      proof_status: 'protocol_receipt_attached',
      tx_hash: '0xfunding',
      funding_tx_hash: '0xfunding',
      settlement_tx_hash: null,
      chain_id: BASE_SEPOLIA,
      resource_url: null,
      merchant_address: null,
      payer_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      settlement_address: null,
      token_symbol: 'USDC',
      token_address: '0x833589fCD6edb6E08f4c7C32D4f71b54bdA02913',
      amount_raw: '500000',
      amount_human: '0.50',
      challenge_id: null,
      idempotency_key: null,
      challenge_payload: null,
      selected_payment: null,
      payment_proof_header_name: null,
      protocol_receipt_header_name: null,
      protocol_receipt_payload: null,
      merchant_status: null,
      confirmed_at: '2026-09-28T10:00:00.000Z',
      created_at: '2026-09-28T10:00:00.000Z',
      updated_at: '2026-09-28T10:00:00.000Z',
    } as never)
    expect(verifyPaymentReceipt(eip3009Row)).toEqual({ verified: false, reason: 'not_a_signed_receipt' })

    expect(verifyPaymentReceipt(null)).toEqual({ verified: false, reason: 'not_a_signed_receipt' })
    expect(verifyPaymentReceipt(undefined)).toEqual({ verified: false, reason: 'not_a_signed_receipt' })
    expect(verifyPaymentReceipt('a list row as a string')).toEqual({
      verified: false,
      reason: 'not_a_signed_receipt',
    })
    expect(verifyPaymentReceipt(42)).toEqual({ verified: false, reason: 'not_a_signed_receipt' })
    expect(verifyPaymentReceipt({})).toEqual({ verified: false, reason: 'not_a_signed_receipt' })
    expect(verifyPaymentReceipt({ authorization: {} })).toEqual({
      verified: false,
      reason: 'not_a_signed_receipt',
    })
    expect(verifyPaymentReceipt({ authorization: { delegate: '0x1', signHash: null } })).toEqual({
      verified: false,
      reason: 'not_a_signed_receipt',
    })
  })
})

describe('verifyPaymentReceipt #3418 — erc7710 verifies over the delegation digest', () => {
  // (b) The live-rail case: signHash is the settlement child's struct hash,
  // the signature is over the DelegationManager EIP-712 digest.
  it('verifies a real erc7710 bundle with verifiedOver delegation_digest', () => {
    expect(CHILD_STRUCT_HASH).not.toBe(erc7710Digest(BASE_SEPOLIA))
    const result = verifyPaymentReceipt(erc7710Receipt({ signatureScheme: 'eip712_delegation' }))
    expect(result).toEqual({
      verified: true,
      recoveredSigner: DELEGATE_7710.address,
      verifiedOver: 'delegation_digest',
    })
  })

  it('verifies on Base mainnet, whose DelegationManager the SDK pins too', () => {
    const signature = DELEGATE_7710.signingKey.sign(erc7710Digest(BASE_MAINNET)).serialized
    const result = verifyPaymentReceipt(
      erc7710Receipt({ chainId: BASE_MAINNET, signature, signatureScheme: 'eip712_delegation' }),
    )
    expect(result).toEqual({
      verified: true,
      recoveredSigner: DELEGATE_7710.address,
      verifiedOver: 'delegation_digest',
    })
  })

  // (c) A bundle signed by another key, and the same bundle presented for a
  // different pinned chain, are forgeries — signer_mismatch either way.
  it('returns signer_mismatch when another key signed the delegation digest', () => {
    const forged = OTHER_7710.signingKey.sign(erc7710Digest(BASE_SEPOLIA)).serialized
    const result = verifyPaymentReceipt(
      erc7710Receipt({ signature: forged, signatureScheme: 'eip712_delegation' }),
    )
    expect(result).toMatchObject({ verified: false, reason: 'signer_mismatch' })
    if (!result.verified) expect(result.recoveredSigner?.toLowerCase()).toBe(OTHER_7710.address.toLowerCase())
  })

  it('returns signer_mismatch when the bundle names a different pinned chain', () => {
    // Signed for Base Sepolia, presented as Base mainnet: the rebuilt digest
    // differs, so the genuine signature no longer recovers to the delegate.
    const result = verifyPaymentReceipt(
      erc7710Receipt({ chainId: BASE_MAINNET, signatureScheme: 'eip712_delegation' }),
    )
    expect(result).toMatchObject({ verified: false, reason: 'signer_mismatch' })
  })

  it('returns not_verifiable_offline for a delegation bundle on a chain the SDK pins no manager for', () => {
    const result = verifyPaymentReceipt(
      erc7710Receipt({ chainId: 1, signatureScheme: 'eip712_delegation' }),
    )
    expect(result).toEqual({ verified: false, reason: 'not_verifiable_offline' })
  })

  it('returns missing_signature before any recovery when the erc7710 bundle has none', () => {
    expect(verifyPaymentReceipt(erc7710Receipt({ signature: null, signatureScheme: 'eip712_delegation' }))).toEqual({
      verified: false,
      reason: 'missing_signature',
    })
  })
})

describe('verifyPaymentReceipt #3418 — userop bundles are not verifiable offline', () => {
  // (d) Direct payments and the eip3009 funding leg sign an ERC-4337
  // UserOperation the bundle does not carry. Never signer_mismatch — that
  // would accuse a genuine payment.
  it('returns not_verifiable_offline for an eip712_userop bundle without attempting recovery', () => {
    const result = verifyPaymentReceipt(
      receipt({
        signature: DELEGATE.signingKey.sign(SIGN_HASH).serialized,
        signatureScheme: 'eip712_userop',
      }),
    )
    expect(result).toEqual({ verified: false, reason: 'not_verifiable_offline' })
  })
})

describe('verifyPaymentReceipt #3418 — retired-rail bundles (no scheme)', () => {
  it('still verifies a raw-signed signHash (the old scheme) as sign_hash', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const result = verifyPaymentReceipt(receipt({ signature }))
    expect(result.verified).toBe(true)
    if (result.verified) expect(result.verifiedOver).toBe('sign_hash')
  })

  it('verifies a delegation bundle from a backend older than #3418 over the rebuilt digest', () => {
    // A delegation-rail bundle emitted before the scheme existed (no
    // signatureScheme): raw recovery fails, the digest rebuild on a pinned
    // chain saves it.
    const result = verifyPaymentReceipt(erc7710Receipt({}))
    expect(result).toEqual({
      verified: true,
      recoveredSigner: DELEGATE_7710.address,
      verifiedOver: 'delegation_digest',
    })
  })

  it('returns signer_mismatch when neither hash recovers to the delegate', () => {
    const forged = OTHER_7710.signingKey.sign(erc7710Digest(BASE_SEPOLIA)).serialized
    const result = verifyPaymentReceipt(erc7710Receipt({ signature: forged }))
    expect(result).toMatchObject({ verified: false, reason: 'signer_mismatch' })
  })
})
