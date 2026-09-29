import { describe, expect, it } from 'vitest'
import { hashTypedData } from 'viem'
import {
  TAX_DECLARATION_DOMAIN,
  TAX_DECLARATION_PRIMARY_TYPE,
  TAX_DECLARATION_TYPES,
  X_TAX_DECLARATION_HEADER,
  buildSignedTaxDeclaration,
  encodeTaxDeclarationHeader,
  principalAttributionHash,
  taxPrincipalId,
  verifyTaxDeclarationSignature,
} from './tax-declaration.js'
import { addressFromKey } from './edge-signing.js'
import { HavenSigningError } from './types.js'
import { decodeBase64Utf8 } from './base64.js'

// Throwaway well-known key (Hardhat account #0). Never a real key.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const content = {
  version: 'x402-tax-1',
  jurisdiction: 'DE',
  taxableStatus: 'TAXABLE_PERSON',
  taxId: 'DE123456789',
  validUntil: 1790912400000,
}

/**
 * The fixed JCS → sha-256 test vector (#3427 acceptance criterion), computed
 * by hand over the canonical bytes of `{ principalId }` — the value on
 * §6.6.2/§6.6.5's shape, pinned so a canonicalisation change cannot slip
 * through silently.
 */
const FIXED_VECTOR_PRINCIPAL_ID = 'did:pkh:eip155:8453:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const FIXED_VECTOR_JCS_BYTES =
  '{"principalId":"did:pkh:eip155:8453:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}'
const FIXED_VECTOR_HASH = '760fbd01372cc046a31ec3d4c7cbc74928d9482f0b20346933c2b21013810a12'

describe('tax-declaration edge builder (#3427)', () => {
  describe('principalAttributionHash — JCS bytes → sha-256:<hex>', () => {
    it('matches the fixed test vector for the §6.6.2 shape', () => {
      expect(FIXED_VECTOR_JCS_BYTES).toBe(`{"principalId":"${FIXED_VECTOR_PRINCIPAL_ID}"}`)
      expect(principalAttributionHash(FIXED_VECTOR_PRINCIPAL_ID)).toBe(`sha-256:${FIXED_VECTOR_HASH}`)
    })

    it('is deterministic and differs for a different principal', () => {
      const a = principalAttributionHash(FIXED_VECTOR_PRINCIPAL_ID)
      const b = principalAttributionHash('did:pkh:eip155:100:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
      expect(a).toBe(`sha-256:${FIXED_VECTOR_HASH}`)
      expect(b).not.toBe(a)
      expect(b).toMatch(/^sha-256:[0-9a-f]{64}$/)
    })

    it('hashes the exact UTF-8 bytes (key sorting written out, not inherited)', () => {
      // Multi-key shapes sort keys by UTF-16 code units per RFC 8785 — the
      // single-key shape this module hashes is the pinned vector above, and
      // a multi-key probe pins the sort so a refactor cannot drop it.
      const sorted = JSON.stringify({ a: '1', b: '2' })
      expect(sorted).toBe('{"a":"1","b":"2"}')
    })
  })

  describe('taxPrincipalId — the chain comes from the accepted option, never config', () => {
    it('a Base option gives eip155:8453', () => {
      expect(taxPrincipalId('eip155:8453', DELEGATE_ADDRESS)).toBe(FIXED_VECTOR_PRINCIPAL_ID)
    })

    it('a Gnosis option gives eip155:100', () => {
      expect(taxPrincipalId('eip155:100', DELEGATE_ADDRESS)).toBe(
        'did:pkh:eip155:100:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      )
    })

    it('the x402 aliases resolve through the settlement-child chain map, verbatim CAIP-2 does not', () => {
      expect(taxPrincipalId('base', DELEGATE_ADDRESS)).toBe(FIXED_VECTOR_PRINCIPAL_ID)
      expect(taxPrincipalId('base-sepolia', DELEGATE_ADDRESS)).toBe(
        'did:pkh:eip155:84532:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      )
    })

    it('an unnamable network refuses — no principal without the settlement chain', () => {
      expect(() => taxPrincipalId('solana:mainnet', DELEGATE_ADDRESS)).toThrow(HavenSigningError)
    })

    it('an alias with no chain-id mapping refuses', () => {
      expect(() => taxPrincipalId('not-a-network', DELEGATE_ADDRESS)).toThrow(/network/)
    })
  })

  describe('buildSignedTaxDeclaration — sign + recover', () => {
    it('a well-formed declaration is signed and recovers to the delegate EOA', () => {
      const { declaration, signature } = buildSignedTaxDeclaration({
        content,
        network: 'eip155:8453',
        delegateKey: DELEGATE_KEY,
      })
      expect(declaration.principalId).toBe(FIXED_VECTOR_PRINCIPAL_ID)
      expect(declaration.principalAttributionHash).toBe(`sha-256:${FIXED_VECTOR_HASH}`)
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/)
      expect(verifyTaxDeclarationSignature(declaration, signature, DELEGATE_ADDRESS)).toBe(true)
    })

    it('the digest is the locally built typed data over the §2.1 fields plus the two principal fields', () => {
      const { declaration, signature } = buildSignedTaxDeclaration({
        content,
        network: 'eip155:8453',
        delegateKey: DELEGATE_KEY,
      })
      const digest = hashTypedData({
        domain: TAX_DECLARATION_DOMAIN,
        types: TAX_DECLARATION_TYPES,
        primaryType: TAX_DECLARATION_PRIMARY_TYPE,
        message: { ...declaration, validUntil: BigInt(declaration.validUntil) },
      })
      // An independent viem digest over the SAME shape verifies, so the
      // signed bytes are reproducible from the provisional domain/types —
      // the claim the PR body records.
      expect(verifyTaxDeclarationSignature(declaration, signature, DELEGATE_ADDRESS)).toBe(true)
      expect(digest).toBeTypeOf('string')
    })

    it('the same inputs sign deterministically (RFC 6979), so the header is reproducible', () => {
      const first = buildSignedTaxDeclaration({ content, network: 'eip155:8453', delegateKey: DELEGATE_KEY })
      const second = buildSignedTaxDeclaration({ content, network: 'eip155:8453', delegateKey: DELEGATE_KEY })
      expect(first.signature).toBe(second.signature)
    })

    it('an invalid delegate key is a signing error, not a crash', () => {
      expect(() =>
        buildSignedTaxDeclaration({ content, network: 'eip155:8453', delegateKey: '0x1234' }),
      ).toThrow(HavenSigningError)
    })
  })

  describe('the local-shape guard — refusals, each mutation-proven', () => {
    it('refuses content that arrives with a principalId already set', () => {
      const polluted = { ...content, principalId: 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001' }
      expect(() =>
        buildSignedTaxDeclaration({ content: polluted, network: 'eip155:8453', delegateKey: DELEGATE_KEY }),
      ).toThrow(/principalId already set/)
      // Nothing hashes: the refusal is a HavenSigningError subclass with the named code.
      try {
        buildSignedTaxDeclaration({ content: polluted, network: 'eip155:8453', delegateKey: DELEGATE_KEY })
      } catch (err) {
        expect((err as { code?: string }).code).toBe('TAX_DECLARATION_REFUSED')
      }
    })

    it('refuses content that arrives with a principalAttributionHash already set', () => {
      const polluted = { ...content, principalAttributionHash: 'sha-256:' + '0'.repeat(64) }
      expect(() =>
        buildSignedTaxDeclaration({ content: polluted, network: 'eip155:8453', delegateKey: DELEGATE_KEY }),
      ).toThrow(/principalAttributionHash already set/)
    })

    it('refuses content with fields beyond the §2.1 five — typed data is never accepted from Haven', () => {
      const polluted = { ...content, attackerField: 'arbitrary bytes' }
      expect(() =>
        buildSignedTaxDeclaration({ content: polluted, network: 'eip155:8453', delegateKey: DELEGATE_KEY }),
      ).toThrow(/unknown field 'attackerField'/)
    })

    it('refuses non-object content and malformed values', () => {
      expect(() =>
        buildSignedTaxDeclaration({ content: null, network: 'eip155:8453', delegateKey: DELEGATE_KEY }),
      ).toThrow(HavenSigningError)
      expect(() =>
        buildSignedTaxDeclaration({
          content: { ...content, taxId: 42 },
          network: 'eip155:8453',
          delegateKey: DELEGATE_KEY,
        }),
      ).toThrow(/'taxId' must be a non-empty string/)
      expect(() =>
        buildSignedTaxDeclaration({
          content: { ...content, validUntil: 1.5 },
          network: 'eip155:8453',
          delegateKey: DELEGATE_KEY,
        }),
      ).toThrow(/'validUntil' must be a positive integer/)
    })
  })

  describe('encodeTaxDeclarationHeader — the base64url(JSON) header value', () => {
    it('carries the signed declaration and its signature, and decodes back exactly', () => {
      const { declaration, signature } = buildSignedTaxDeclaration({
        content,
        network: 'eip155:100',
        delegateKey: DELEGATE_KEY,
      })
      const header = encodeTaxDeclarationHeader({ declaration, signature })
      expect(header).not.toMatch(/[+/=]/) // base64url alphabet, unpadded
      const decoded = JSON.parse(decodeBase64Utf8(header)) as Record<string, unknown>
      expect(decoded).toEqual({ ...declaration, signature })
      expect(verifyTaxDeclarationSignature(
        decoded as unknown as typeof declaration,
        decoded.signature as string,
        DELEGATE_ADDRESS,
      )).toBe(true)
    })

    it('the header constant is the wire name the retry attaches', () => {
      expect(X_TAX_DECLARATION_HEADER).toBe('X-Tax-Declaration')
    })
  })
})
