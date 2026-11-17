import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  TAX_DECLARATION_DOMAIN,
  TAX_DECLARATION_PRIMARY_TYPE,
  TAX_DECLARATION_TYPES,
  buildSignedTaxDeclaration,
  encodeTaxDeclarationHeader,
  taxPrincipalId,
} from '@haven_ai/sdk/edge'
import { acceptTaxDeclaration, vatTreatmentFor, type AcceptedTaxDeclaration, type VatRule } from './tax-declaration.js'

const RULE: VatRule = 'SE_25_WITH_EU_REVERSE_CHARGE'

const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const OTHER_KEY = `0x${'02'.repeat(32)}` as const
const PAYER = privateKeyToAccount(PAYER_KEY).address
const CHAIN_ID = 8453
const NETWORK = `eip155:${CHAIN_ID}`
const FUTURE = Date.now() + 30 * 24 * 60 * 60 * 1000

const CONTENT = {
  version: 'x402-tax-1',
  jurisdiction: 'SE',
  taxableStatus: 'TAXABLE_PERSON',
  taxId: 'SE559412345601',
  validUntil: FUTURE,
}

/** A correctly signed declaration header, with the knobs each refusal needs. */
function headerFor(
  overrides: Partial<typeof CONTENT> = {},
  opts: { key?: string; network?: string } = {},
): string {
  return encodeTaxDeclarationHeader(
    buildSignedTaxDeclaration({
      content: { ...CONTENT, ...overrides },
      network: opts.network ?? NETWORK,
      delegateKey: opts.key ?? PAYER_KEY,
    }),
  )
}

function accept(header: string | undefined, now?: number): AcceptedTaxDeclaration | null {
  return acceptTaxDeclaration({ header, payer: PAYER, chainId: CHAIN_ID, now })
}

describe('acceptTaxDeclaration (#4855)', () => {
  it('accepts a Swedish declaration signed by the payer and returns the four display fields', () => {
    expect(accept(headerFor())).toEqual({
      jurisdiction: 'SE',
      taxId: 'SE559412345601',
      taxableStatus: 'TAXABLE_PERSON',
      validUntil: FUTURE,
    })
  })

  it('accepts a declaration from another EU country', () => {
    const accepted = accept(headerFor({ jurisdiction: 'DE', taxId: 'DE123456789' }))
    expect(accepted).toMatchObject({ jurisdiction: 'DE', taxId: 'DE123456789' })
  })

  it('treats a missing header as no declaration', () => {
    expect(accept(undefined)).toBeNull()
    expect(accept('')).toBeNull()
  })

  it('treats an unreadable header as no declaration', () => {
    expect(accept('not-base64-json')).toBeNull()
    expect(accept(Buffer.from('{"version":"x402-tax-1"}', 'utf8').toString('base64url'))).toBeNull()
    expect(accept(Buffer.from('[]', 'utf8').toString('base64url'))).toBeNull()
  })

  it('refuses a bad signature', () => {
    const parsed = JSON.parse(Buffer.from(headerFor(), 'base64url').toString('utf8'))
    parsed.signature = '0xdeadbeef'
    expect(accept(Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url'))).toBeNull()
  })

  it('refuses a declaration whose signer is not the payment payer', () => {
    // Correctly signed, correct principal for the OTHER key — but that key did
    // not sign the payment, so the recovered signer is not the payer.
    expect(accept(headerFor({}, { key: OTHER_KEY }))).toBeNull()
  })

  it('refuses a principalId that names another chain', () => {
    // Signed correctly over a principal scoped to Base Sepolia: the signature
    // and the attribution hash are both valid, so only the principal check can
    // refuse this one.
    expect(accept(headerFor({}, { network: 'eip155:84532' }))).toBeNull()
  })

  it('refuses a principalAttributionHash that does not recompute', () => {
    const declaration = {
      ...CONTENT,
      principalId: taxPrincipalId(NETWORK, PAYER),
      principalAttributionHash: `sha-256:${'00'.repeat(32)}`,
    }
    // Signed by the payer over the WRONG hash, so the signature verifies and
    // only the recomputation can refuse it.
    const signature = privateKeyToAccount(PAYER_KEY).signTypedData({
      domain: TAX_DECLARATION_DOMAIN,
      types: TAX_DECLARATION_TYPES,
      primaryType: TAX_DECLARATION_PRIMARY_TYPE,
      message: { ...declaration, validUntil: BigInt(declaration.validUntil) },
    })
    return signature.then((sig) => {
      const header = Buffer.from(JSON.stringify({ ...declaration, signature: sig }), 'utf8').toString('base64url')
      expect(accept(header)).toBeNull()
    })
  })

  it('refuses an expired declaration', () => {
    const expired = Date.now() - 1_000
    expect(accept(headerFor({ validUntil: expired }))).toBeNull()
    // The same declaration is accepted while it is still in the future.
    expect(accept(headerFor({ validUntil: expired }), expired - 1)).not.toBeNull()
  })

  it('never throws on a hostile payload', () => {
    const hostile = Buffer.from(
      JSON.stringify({
        version: 'x402-tax-1',
        jurisdiction: 'SE',
        taxableStatus: 'TAXABLE_PERSON',
        taxId: 'SE559412345601',
        validUntil: 1.5,
        principalId: 'did:pkh:eip155:8453:0x0',
        principalAttributionHash: 'sha-256:00',
        signature: '0x00',
      }),
      'utf8',
    ).toString('base64url')
    expect(() => accept(hostile)).not.toThrow()
    expect(accept(hostile)).toBeNull()
  })
})

describe('vatTreatmentFor (#4855)', () => {
  const declaration = (jurisdiction: string): AcceptedTaxDeclaration => ({
    jurisdiction,
    taxId: 'X',
    taxableStatus: 'TAXABLE_PERSON',
    validUntil: FUTURE,
  })

  it('is SE_25 with no accepted declaration', () => {
    expect(vatTreatmentFor(null, RULE)).toBe('SE_25')
  })

  it('is SE_25 for a Swedish declaration', () => {
    expect(vatTreatmentFor(declaration('SE'), RULE)).toBe('SE_25')
    expect(vatTreatmentFor(declaration('se'), RULE)).toBe('SE_25')
  })

  it('is REVERSE_CHARGE for another EU country', () => {
    for (const country of ['DE', 'FR', 'NL', 'ES', 'GR', 'IE']) {
      expect(vatTreatmentFor(declaration(country), RULE)).toBe('REVERSE_CHARGE')
    }
  })

  it('falls back to SE_25 for a non-EU jurisdiction — no non-EU treatment is built', () => {
    expect(vatTreatmentFor(declaration('US'), RULE)).toBe('SE_25')
    expect(vatTreatmentFor(declaration('GB'), RULE)).toBe('SE_25')
  })

  it('refuses a rule it does not implement — the core has no default rule (#4890)', () => {
    expect(() => vatTreatmentFor(null, 'SE_12' as unknown as VatRule)).toThrow(/Unsupported VAT rule/)
  })
})
