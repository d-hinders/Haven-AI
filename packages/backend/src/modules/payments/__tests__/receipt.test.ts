import { afterEach, describe, it, expect } from 'vitest'
import { Wallet } from 'ethers'
import { hashTypedData, type Hex } from 'viem'
import { hashDelegation, SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils'
import { DELEGATION_MANAGER } from '@haven_ai/sdk/edge'
import { config } from '../../../config.js'
import {
  buildPaymentReceipt,
  verifyPaymentReceipt,
  RECEIPT_VERSION,
  type PaymentReceiptRow,
} from '../receipt.js'

const DELEGATE = new Wallet(`0x${'11'.repeat(32)}`)
const SIGN_HASH = `0x${'ab'.repeat(32)}`

function row(over: Partial<PaymentReceiptRow> = {}): PaymentReceiptRow {
  return {
    id: 'pi1',
    account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    chain_id: 100,
    token_symbol: 'xDAI',
    token_address: '0x0000000000000000000000000000000000000000',
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_human: '1',
    delegate_address: DELEGATE.address,
    sign_hash: SIGN_HASH,
    signature: null,
    tx_hash: `0x${'cd'.repeat(32)}`,
    confirmed_at: '2026-06-20T10:00:00.000Z',
    resource_url: 'https://api.example/resource',
    amount_sek: '10.60',
    ...over,
  }
}

describe('buildPaymentReceipt (backend DB mapping)', () => {
  it('assembles a versioned bundle with payment, authorization, and on-chain parts', () => {
    const r = buildPaymentReceipt(row({ signature: '0xsig' }))
    expect(r.version).toBe(RECEIPT_VERSION)
    expect(r.paymentId).toBe('pi1')
    expect(r.payment).toMatchObject({ token: 'xDAI', amount: '1', amountSek: '10.60', recipient: row().to_address })
    expect(r.authorization).toEqual({ delegate: DELEGATE.address, signHash: SIGN_HASH, signature: '0xsig' })
    expect(r.onChain).toEqual({ txHash: row().tx_hash, chainId: 100 })
  })

  it('produces a receipt that verifies via the SDK verifier (end-to-end)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const receipt = buildPaymentReceipt(row({ signature }))
    expect(verifyPaymentReceipt(receipt).verified).toBe(true)
  })

  // #2907: payment.account twins payment.safe (same value) — additive,
  // outside the SDK's typed PaymentReceipt['payment'] shape, so asserted at
  // the JS-object level rather than through the TS type. Mutation-proven by
  // dropping the `account: row.account_address` line in receipt.ts.
  it('#2907: payment.account is a same-value twin of payment.safe', () => {
    const r = buildPaymentReceipt(row({ signature: '0xsig' })) as unknown as {
      payment: { safe: string; account: string }
    }
    expect(r.payment.account).toBe(r.payment.safe)
    expect(r.payment.account).toBe('0x135a9215604711AC70d970e12Caa812c53537EF4')
  })

  it('#2907: verification still passes with the additive payment.account field present (signHash is stored, not recomputed over payment)', () => {
    const signature = DELEGATE.signingKey.sign(SIGN_HASH).serialized
    const receipt = buildPaymentReceipt(row({ signature }))
    expect(verifyPaymentReceipt(receipt).verified).toBe(true)
  })

  // #3332 review M2 — the FLAG WIRING in this file, not just
  // `buyerPartyFromJoin`'s own pure test: a row that carries buyer_* columns
  // must not surface `parties.buyer` when `config.ownerCompanyDetailsEnabled`
  // is false, and must surface it (present, never present-and-null) when
  // true. Mutation-proven: replacing `config.ownerCompanyDetailsEnabled` with
  // a literal `true` at this file's call site would make the "off" case
  // below fail.
  describe('#3332: parties.buyer flag wiring', () => {
    const originalFlag = config.ownerCompanyDetailsEnabled

    afterEach(() => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = originalFlag
    })

    const buyerRow = row({
      buyer_legal_name: 'Acme AB',
      buyer_country: 'SE',
      buyer_org_number: '556677-8899',
      buyer_vat_number: 'SE556677889901',
      buyer_vies_status: 'valid',
      buyer_vies_checked_at: '2026-09-20T10:00:00.000Z',
    })

    it('flag OFF: parties has no "buyer" key at all, even with a fully-populated join', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = false
      const r = buildPaymentReceipt(buyerRow) as unknown as { payment: { parties: Record<string, unknown> } }
      expect('buyer' in r.payment.parties).toBe(false)
    })

    it('flag ON: parties.buyer is present and shaped correctly', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const r = buildPaymentReceipt(buyerRow) as unknown as {
        payment: { parties: { buyer?: Record<string, unknown> } }
      }
      expect(r.payment.parties.buyer).toEqual({
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'valid',
        vies_checked_at: '2026-09-20T10:00:00.000Z',
      })
    })

    it('flag ON but no saved details (join columns null): still no "buyer" key', () => {
      ;(config as { ownerCompanyDetailsEnabled: boolean }).ownerCompanyDetailsEnabled = true
      const r = buildPaymentReceipt(row()) as unknown as { payment: { parties: Record<string, unknown> } }
      expect('buyer' in r.payment.parties).toBe(false)
    })
  })
})

// ── #3418: the bundle names which digest the delegate signed ─────────────────

describe('buildPaymentReceipt #3418: authorization.signatureScheme mapping', () => {
  // Mutation-proven by making signatureSchemeFor return undefined always:
  // the erc7710 case below fails.
  it('erc7710 row (settlement_scheme) → eip712_delegation', () => {
    const r = buildPaymentReceipt(row({ settlement_scheme: 'erc7710', execution_rail: 'delegation' }))
    expect(r.authorization.signatureScheme).toBe('eip712_delegation')
  })

  it('delegation-rail row without erc7710 (the eip3009 funding leg) → eip712_userop', () => {
    const r = buildPaymentReceipt(row({ settlement_scheme: 'eip3009', execution_rail: 'delegation' }))
    expect(r.authorization.signatureScheme).toBe('eip712_userop')
  })

  it('direct row → absent', () => {
    const r = buildPaymentReceipt(row({ execution_rail: 'direct' }))
    expect('signatureScheme' in r.authorization).toBe(false)
  })

  it('legacy row (pre-#3418 columns absent) → absent, so the retired-rail raw check is unchanged', () => {
    const r = buildPaymentReceipt(row())
    expect('signatureScheme' in r.authorization).toBe(false)
  })

  it('erc7710 end-to-end: the built bundle verifies over the delegation digest', () => {
    // The row as the receipt SQL returns it: sign_hash is the settlement
    // child's struct hash, chain 84532, the delegate's signature over the
    // EIP-712 delegation digest (what the backend recovers at settle).
    const digest = hashTypedData({
      domain: {
        name: 'DelegationManager',
        version: '1',
        chainId: 84532,
        verifyingContract: DELEGATION_MANAGER,
      },
      types: SIGNABLE_DELEGATION_TYPED_DATA,
      primaryType: 'Delegation',
      message: {
        delegate: ('0x15179876c595922999C2d5DC7c23Cc7711fE799a') as Hex,
        delegator: ('0x135a9215604711AC70d970e12Caa812c53537EF4') as Hex,
        authority: (`0x${'00'.repeat(32)}`) as Hex,
        caveats: [
          { enforcer: ('0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc') as Hex, terms: (`0x${'cd'.repeat(32)}`) as Hex },
        ],
        salt: BigInt(`0x${'ab'.repeat(32)}`),
      },
    })
    const childStructHash = hashDelegation({
      delegate: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
      delegator: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      authority: `0x${'00'.repeat(32)}`,
      caveats: [{ enforcer: '0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc', terms: `0x${'cd'.repeat(32)}` }],
      salt: `0x${'ab'.repeat(32)}`,
      signature: '0x',
    } as never) as Hex
    expect(childStructHash).not.toBe(digest)
    const erc7710Row = row({
      chain_id: 84532,
      sign_hash: childStructHash,
      signature: DELEGATE.signingKey.sign(digest).serialized,
      settlement_scheme: 'erc7710',
      execution_rail: 'delegation',
    })
    const receipt = buildPaymentReceipt(erc7710Row)
    const result = verifyPaymentReceipt(receipt)
    expect(result).toEqual({
      verified: true,
      recoveredSigner: DELEGATE.address,
      verifiedOver: 'delegation_digest',
    })
  })

  it('eip3009 end-to-end: the built bundle is not_verifiable_offline, never signer_mismatch', () => {
    const receipt = buildPaymentReceipt(
      row({ signature: '0xsig', settlement_scheme: 'eip3009', execution_rail: 'delegation' }),
    )
    expect(verifyPaymentReceipt(receipt)).toEqual({
      verified: false,
      reason: 'not_verifiable_offline',
    })
  })
})

// ── #4822: the bundle names the merchant, not the agent's own delegate ───────
//
// On the EIP-3009 bridge the intent row is the FUNDING leg: `to_address` is
// the agent's own delegate, and the merchant named at authorize sits in
// `merchant_address` / `x402_merchant_address`. The bundle used to name
// `to_address` as the merchant. These tests pin the corrected party, the new
// `settlementTxHash` field, and that every other field keeps its value.

describe('buildPaymentReceipt #4822: merchant party and settlementTxHash', () => {
  const DELEGATE_EOA = '0xcb9a000000000000000000000000000000005ba8'
  const MERCHANT = '0x041500000000000000000000000000000000b195'
  const FUNDING_TX = `0x${'cd'.repeat(32)}`
  const SETTLEMENT_TX = `0x${'5e'.repeat(32)}`

  /** The row shape the receipt SQL returns for an EIP-3009 funding leg. */
  function eip3009Row(over: Partial<PaymentReceiptRow> = {}): PaymentReceiptRow {
    return row({
      to_address: DELEGATE_EOA,
      merchant_address: MERCHANT,
      settlement_scheme: 'eip3009',
      execution_rail: 'delegation',
      tx_hash: FUNDING_TX,
      ...over,
    })
  }

  it('recorded settlement: parties.merchant is the named merchant, settlementTxHash is the verified hash', () => {
    const r = buildPaymentReceipt(eip3009Row({ merchant_settlement_tx_hash: SETTLEMENT_TX }))
    expect(r.payment.parties?.merchant).toBe(MERCHANT)
    expect(r.settlementTxHash).toBe(SETTLEMENT_TX)
    // The funding leg keeps its own names: recipient and onChain.txHash are
    // the delegate and the funding transaction (owner decision 2026-11-12).
    expect(r.payment.recipient).toBe(DELEGATE_EOA)
    expect(r.onChain.txHash).toBe(FUNDING_TX)
  })

  it('not recorded: parties.merchant is still the named merchant, settlementTxHash is null', () => {
    const r = buildPaymentReceipt(eip3009Row({ merchant_settlement_tx_hash: null }))
    expect(r.payment.parties?.merchant).toBe(MERCHANT)
    expect(r.settlementTxHash).toBeNull()
    expect(r.payment.recipient).toBe(DELEGATE_EOA)
    expect(r.onChain.txHash).toBe(FUNDING_TX)
  })

  it('echo-only: the merchant\'s unverified echo is never used — settlementTxHash stays null', () => {
    // The echo is what the receipt LIST surfaces as `settlement_tx_hash`
    // (`protocol_receipt_payload.transaction`). The builder has no input for
    // it; this row carries one anyway, and the field must stay null. Mutation
    // guard: reading `row.settlement_tx_hash` here would turn this red.
    const echoOnly = {
      ...eip3009Row({ merchant_settlement_tx_hash: null }),
      settlement_tx_hash: `0x${'ee'.repeat(32)}`,
    } as PaymentReceiptRow
    const r = buildPaymentReceipt(echoOnly)
    expect(r.settlementTxHash).toBeNull()
    expect(r.payment.parties?.merchant).toBe(MERCHANT)
  })

  it('stored casing is kept on the merchant party (#3307 kept the signed bundle unchanged)', () => {
    const mixedCase = '0x041500000000000000000000000000000000B195'
    const r = buildPaymentReceipt(eip3009Row({ merchant_address: mixedCase }))
    expect(r.payment.parties?.merchant).toBe(mixedCase)
  })

  it('erc7710: every field keeps its value; settlementTxHash equals onChain.txHash', () => {
    const erc7710Row = row({
      settlement_scheme: 'erc7710',
      execution_rail: 'delegation',
      merchant_address: row().to_address,
    })
    const r = buildPaymentReceipt(erc7710Row)
    expect(r).toEqual({
      version: RECEIPT_VERSION,
      paymentId: 'pi1',
      payment: {
        token: 'xDAI',
        tokenAddress: '0x0000000000000000000000000000000000000000',
        amount: '1',
        amountSek: '10.60',
        recipient: row().to_address,
        safe: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        account: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        chainId: 100,
        settledAt: '2026-06-20T10:00:00.000Z',
        resourceUrl: 'https://api.example/resource',
        deliveryQuality: null,
        parties: {
          treasury_account: '0x135a9215604711AC70d970e12Caa812c53537EF4',
          delegate: DELEGATE.address,
          delegate_account: null,
          merchant: row().to_address,
        },
      },
      authorization: {
        delegate: DELEGATE.address,
        signHash: SIGN_HASH,
        signature: null,
        signatureScheme: 'eip712_delegation',
      },
      onChain: { txHash: row().tx_hash, chainId: 100 },
      settlementTxHash: row().tx_hash,
    })
  })

  it('direct: every field keeps its value; settlementTxHash equals onChain.txHash', () => {
    const r = buildPaymentReceipt(row({ execution_rail: 'direct' }))
    expect(r.payment.parties?.merchant).toBe(row().to_address)
    expect(r.settlementTxHash).toBe(row().tx_hash)
    expect(r.onChain.txHash).toBe(row().tx_hash)
    expect('signatureScheme' in r.authorization).toBe(false)
  })

  it('retired-rail row with no merchant column: merchant falls back to to_address, settlementTxHash is tx_hash', () => {
    // A row read by the pre-#4822 SQL carries no `merchant_address` at all.
    const legacy = row()
    const r = buildPaymentReceipt(legacy)
    expect(r.payment.parties?.merchant).toBe(legacy.to_address)
    expect(r.settlementTxHash).toBe(legacy.tx_hash)
    expect(r.payment.recipient).toBe(legacy.to_address)
  })

  it('verification is unchanged per scheme with the additive field present', () => {
    // The #3418 end-to-end tests above already pin `verified: true` (erc7710)
    // and `not_verifiable_offline` (eip3009) on bundles that now carry
    // `settlementTxHash` — `buildPaymentReceipt` always emits it. This pins
    // the narrower claim: the field itself changes nothing about the result.
    const erc7710 = buildPaymentReceipt(
      row({ settlement_scheme: 'erc7710', execution_rail: 'delegation', merchant_address: row().to_address }),
    )
    const eip3009 = buildPaymentReceipt(eip3009Row({ merchant_settlement_tx_hash: SETTLEMENT_TX }))
    for (const bundle of [erc7710, eip3009]) {
      const { settlementTxHash: _dropped, ...withoutField } = bundle
      expect(verifyPaymentReceipt(bundle)).toEqual(verifyPaymentReceipt(withoutField as never))
    }
  })
})
