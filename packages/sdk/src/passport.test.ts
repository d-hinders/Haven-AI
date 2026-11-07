/**
 * #4723 (epic #4718): the merchant-side Agent Passport verifier.
 *
 * The cross-check against the BACKEND's signer lives in the backend's tests
 * (`modules/passport/__tests__/passport-sdk-cross-check.test.ts`) because the
 * SDK cannot import the backend. This file pins the SDK's own contract: the
 * canonical bytes, a fixed-key signature vector, the reason vocabulary, the
 * subject binding, and the wrapper's never-throw behaviour.
 */
import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  PASSPORT_CHECK_TIMEOUT_MS,
  PASSPORT_RECEIPT_VERSION,
  canonicalizePassportReceipt,
  checkPassport,
  verifyPassportReceipt,
  verifyPassportReceiptSignature,
  type PassportReceipt,
  type SignedPassportReceipt,
} from './passport.js'

// A fixed, well-known test key. Its address is the issuer every fixture pins.
const ISSUER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ISSUER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const PAYER = '0x2222222222222222222222222222222222222222'
const SMART_ACCOUNT = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'
const UID = `0x${'ab'.repeat(32)}`
const OTHER_UID = `0x${'cd'.repeat(32)}`
const CHAIN_ID = 84532
const NOW = 1_800_000_000

function receipt(overrides: Partial<PassportReceipt> = {}): PassportReceipt {
  return {
    version: PASSPORT_RECEIPT_VERSION,
    issuer: ISSUER,
    agentId: 'agent-1',
    agentEoa: PAYER,
    smartAccount: SMART_ACCOUNT,
    assuranceLevel: 0,
    standing: 'active',
    anchor: 'anchored',
    evidenceUid: UID,
    chainId: CHAIN_ID,
    controls: { rail: 'delegation', policyEnforcedOnchain: true, treasuryBound: true },
    standingEpoch: 1_700_000_000_000,
    issuedAt: NOW - 10,
    expiresAt: NOW + 290,
    ...overrides,
  }
}

async function signed(overrides: Partial<PassportReceipt> = {}): Promise<SignedPassportReceipt> {
  const value = receipt(overrides)
  const signature = await new Wallet(ISSUER_KEY).signMessage(canonicalizePassportReceipt(value))
  return { receipt: value, signature }
}

function body(value: SignedPassportReceipt) {
  return { found: true as const, receipt: value.receipt, signature: value.signature }
}

const OPTIONS = { issuer: ISSUER, payer: PAYER, chainId: CHAIN_ID, nowSeconds: NOW }

describe('canonicalizePassportReceipt', () => {
  // A LITERAL vector. The whole point of a golden vector is that it does not
  // move when the implementation moves: a reordering or a serialization change
  // stays self-consistent (sign and verify with the same function) and still
  // breaks every merchant using the documented snippet. This is the only thing
  // that catches that.
  it('produces the pinned canonical string', () => {
    expect(canonicalizePassportReceipt(receipt())).toBe(CANONICAL_VECTOR)
  })

  it('sorts keys at every depth, so a re-serialized receipt verifies', () => {
    const shuffled = {
      expiresAt: NOW + 290,
      controls: { treasuryBound: true, policyEnforcedOnchain: true, rail: 'delegation' },
      issuedAt: NOW - 10,
      standingEpoch: 1_700_000_000_000,
      chainId: CHAIN_ID,
      evidenceUid: UID,
      anchor: 'anchored',
      standing: 'active',
      assuranceLevel: 0,
      smartAccount: SMART_ACCOUNT,
      agentEoa: PAYER,
      agentId: 'agent-1',
      issuer: ISSUER,
      version: PASSPORT_RECEIPT_VERSION,
    } as PassportReceipt
    expect(canonicalizePassportReceipt(shuffled)).toBe(canonicalizePassportReceipt(receipt()))
  })

  // The `/1` failure family: the array form of JSON.stringify's replacer is a
  // recursive property ALLOW-LIST, so `controls` serializes as `{}` and drops
  // out of the digest. This is the independent implementation from the doc
  // snippet, and it must agree byte-for-byte.
  it('agrees with the documented snippet implementation', () => {
    const canon = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canon)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
          : v
    expect(JSON.stringify(canon(receipt()))).toBe(canonicalizePassportReceipt(receipt()))
  })

  it('refuses a non-plain value rather than silently dropping it', () => {
    expect(() => canonicalizePassportReceipt({ ...receipt(), issuedAt: new Date() } as never)).toThrow(
      /cannot canonicalize/,
    )
  })
})

describe('verifyPassportReceiptSignature', () => {
  // A fixed-key signature vector: the same receipt and the same key must always
  // produce these bytes. If the canonical form moves, this fails even though
  // sign+verify would still agree with each other.
  it('produces the pinned signature for the pinned receipt', async () => {
    expect((await signed()).signature).toBe(SIGNATURE_VECTOR)
  })

  it('accepts a receipt signed by the pinned issuer', async () => {
    expect(verifyPassportReceiptSignature(await signed(), ISSUER, NOW)).toEqual({ valid: true, issuer: ISSUER })
  })

  it('rejects a receipt whose controls were mutated', async () => {
    const value = await signed()
    const forged = { ...value, receipt: { ...value.receipt, controls: { ...value.receipt.controls!, policyEnforcedOnchain: false } } }
    expect(verifyPassportReceiptSignature(forged, ISSUER, NOW)).toEqual({
      valid: false,
      reason: 'not_signed_by_issuer',
    })
  })

  it('rejects an expired receipt', async () => {
    expect(verifyPassportReceiptSignature(await signed(), ISSUER, NOW + 1000)).toEqual({
      valid: false,
      reason: 'expired',
    })
  })

  it('rejects an unsupported version', async () => {
    const value = await signed({ version: 'haven-passport-receipt/1' })
    expect(verifyPassportReceiptSignature(value, ISSUER, NOW)).toEqual({
      valid: false,
      reason: 'unsupported_version',
    })
  })

  it('rejects a structurally invalid signature', async () => {
    const value = await signed()
    expect(verifyPassportReceiptSignature({ ...value, signature: '0xdeadbeef' }, ISSUER, NOW)).toEqual({
      valid: false,
      reason: 'malformed_signature',
    })
  })
})

describe('verifyPassportReceipt', () => {
  it('answers ok for an authentic, unexpired, chain-matched, subject-bound receipt', async () => {
    expect(verifyPassportReceipt(body(await signed()), OPTIONS)).toEqual({
      ok: true,
      standing: 'active',
      reason: null,
      checked_at: new Date(NOW * 1000).toISOString(),
    })
  })

  it('never takes the issuer from the receipt: the receipt’s own issuer as the pin is a mismatch', async () => {
    const value = await signed()
    // The receipt's `issuer` field is the real issuer, so pinning it is
    // circular — but the point here is that the pin is an ARGUMENT, and a
    // wrong one is refused even when the artifact is authentic.
    expect(verifyPassportReceipt(body(value), { ...OPTIONS, issuer: OTHER })).toMatchObject({
      ok: false,
      standing: null,
      reason: 'not_signed_by_issuer',
    })
  })

  it('reports not_active with the receipt’s standing', async () => {
    expect(verifyPassportReceipt(body(await signed({ standing: 'revoked' })), OPTIONS)).toMatchObject({
      ok: false,
      standing: 'revoked',
      reason: 'not_active',
    })
  })

  it('reports no_passport from the verifier’s own answer', () => {
    expect(verifyPassportReceipt({ found: false, reason: 'no_passport' }, OPTIONS)).toMatchObject({
      ok: false,
      standing: null,
      reason: 'no_passport',
    })
  })

  it('reports unsupported_assurance_level from the verifier’s own answer', () => {
    expect(verifyPassportReceipt({ found: false, reason: 'unsupported_assurance_level' }, OPTIONS)).toMatchObject({
      ok: false,
      reason: 'unsupported_assurance_level',
    })
  })

  it('reports unavailable for a body that is not a body', () => {
    expect(verifyPassportReceipt(null, OPTIONS)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(verifyPassportReceipt({ found: 'yes' }, OPTIONS)).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  describe('subject binding (#4723 spec review, blocking finding)', () => {
    it('refuses a payer the receipt does not bind', async () => {
      expect(verifyPassportReceipt(body(await signed()), { ...OPTIONS, payer: OTHER })).toMatchObject({
        ok: false,
        standing: null,
        reason: 'subject_mismatch',
      })
    })

    it('binds the EIP-3009 payer to agentEoa, not to the smart account', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), { ...OPTIONS, payer: SMART_ACCOUNT, rail: 'eip3009' }),
      ).toMatchObject({ ok: false, reason: 'subject_mismatch' })
      expect(
        verifyPassportReceipt(body(await signed()), { ...OPTIONS, payer: PAYER, rail: 'eip3009' }),
      ).toMatchObject({ ok: true })
    })

    it('binds the erc7710 payer to smartAccount, not to the EOA', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), { ...OPTIONS, payer: PAYER, rail: 'erc7710' }),
      ).toMatchObject({ ok: false, reason: 'subject_mismatch' })
      expect(
        verifyPassportReceipt(body(await signed()), { ...OPTIONS, payer: SMART_ACCOUNT, rail: 'erc7710' }),
      ).toMatchObject({ ok: true })
    })

    it('refuses a receipt that names another chain', async () => {
      expect(verifyPassportReceipt(body(await signed({ chainId: 8453 })), OPTIONS)).toMatchObject({
        ok: false,
        reason: 'subject_mismatch',
      })
    })

    it('refuses a reference that names another chain', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), {
          ...OPTIONS,
          reference: { attestation_uid: UID, chain_id: 8453 },
        }),
      ).toMatchObject({ ok: false, reason: 'subject_mismatch' })
    })

    it('refuses a malformed attestation_uid', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), {
          ...OPTIONS,
          reference: { attestation_uid: '0xnothex', chain_id: CHAIN_ID },
        }),
      ).toMatchObject({ ok: false, reason: 'subject_mismatch' })
    })

    // The regression case from the spec review: a header carrying active agent
    // B's UID, paid by agent A. The address lookup already returns A's
    // passport; the UID cross-check is what makes the "lent passport" shape
    // visible instead of silently reporting A's standing.
    it('refuses a reference whose UID is another agent’s', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), {
          ...OPTIONS,
          reference: { attestation_uid: OTHER_UID, chain_id: CHAIN_ID },
        }),
      ).toMatchObject({ ok: false, standing: null, reason: 'subject_mismatch' })
    })

    it('accepts a reference that agrees with the receipt', async () => {
      expect(
        verifyPassportReceipt(body(await signed()), {
          ...OPTIONS,
          reference: { attestation_uid: UID, chain_id: CHAIN_ID },
        }),
      ).toMatchObject({ ok: true, standing: 'active' })
    })
  })

  it('throws on a malformed required option — a bad pin is a bug, not an answer', () => {
    expect(() => verifyPassportReceipt({ found: false }, { ...OPTIONS, issuer: 'nope' })).toThrow(TypeError)
    expect(() => verifyPassportReceipt({ found: false }, { ...OPTIONS, payer: 'nope' })).toThrow(TypeError)
    expect(() => verifyPassportReceipt({ found: false }, { ...OPTIONS, chainId: 0 })).toThrow(TypeError)
  })
})

describe('checkPassport', () => {
  const BASE = 'https://haven.test'

  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  }

  it('looks the passport up by PAYER ADDRESS, never by the carried UID', async () => {
    const urls: string[] = []
    const value = await signed()
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      reference: { attestation_uid: UID, chain_id: CHAIN_ID },
      fetch: (async (url: string) => {
        urls.push(url)
        return jsonResponse(body(value))
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(urls).toEqual([`${BASE}/passport/verify?address=${PAYER}`])
  })

  it('verifies a 200 body', async () => {
    const value = await signed()
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      fetch: (async () => jsonResponse(body(value))) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: true, standing: 'active', reason: null })
  })

  it('answers unavailable on 503', async () => {
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ error: 'not configured' }, 503)) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: false, standing: null, reason: 'unavailable' })
  })

  it('answers unavailable on 429', async () => {
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      fetch: (async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('answers unavailable on a non-JSON body', async () => {
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      fetch: (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('answers unavailable on a network error', async () => {
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('answers unavailable on a timeout, and never throws', async () => {
    const result = await checkPassport({
      ...OPTIONS,
      baseUrl: BASE,
      timeoutMs: 10,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ ok: false, standing: null, reason: 'unavailable' })
  })

  it('defaults to the shared 1500 ms bound', () => {
    expect(PASSPORT_CHECK_TIMEOUT_MS).toBe(1500)
  })
})

// Filled from a real run of the fixture above; see the two vector tests.
const CANONICAL_VECTOR = `{"agentEoa":"0x2222222222222222222222222222222222222222","agentId":"agent-1","anchor":"anchored","assuranceLevel":0,"chainId":84532,"controls":{"policyEnforcedOnchain":true,"rail":"delegation","treasuryBound":true},"evidenceUid":"0xabababababababababababababababababababababababababababababababab","expiresAt":1800000290,"issuedAt":1799999990,"issuer":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","smartAccount":"0x3333333333333333333333333333333333333333","standing":"active","standingEpoch":1700000000000,"version":"haven-passport-receipt/2"}`
const SIGNATURE_VECTOR = '0xf41a7ba08c8058822e914e74475f3dc5c647b2e32ad631e23b5d9ef7ab4fa9055c0d3d8c7d67b6495838dc74b2cd41f1ef188963e92e238df00edd7da21445821c'
