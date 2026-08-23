/**
 * Domain-ownership proof tests (epic #1717, #1712).
 *
 * This slice is a security control, so the tests are written the way a
 * security control has to be tested: the interesting half is everything that
 * must be REFUSED. Three refusals are load-bearing and named so a mutation
 * shows up unambiguously in the failure output —
 *
 *   'refuses a proof computed from a DIFFERENT verify token'
 *   'refuses a proof computed for a DIFFERENT domain'
 *   'refuses an expired token, without making any outbound request'
 *
 * Pure-unit by construction: the guarded reader and the DNS resolver are both
 * injected, so no network and no database are touched.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  OWNERSHIP_PAYLOAD_PREFIX,
  TOKEN_TTL_MS,
  deriveOwnershipProof,
  dnsTxtName,
  expectedProofPayload,
  isTokenExpired,
  ownershipInstructions,
  tokenExpiresAt,
  verifyDomainOwnership,
  wellKnownPath,
  wellKnownUrl,
  type OwnershipClaim,
} from '../ownership.js'
import type { SafeFetchResult } from '../../../infra/http/ssrf-guard.js'

const SECRET = 'test-ownership-secret-not-a-real-key'
const ISSUED_AT = new Date('2026-08-23T12:00:00.000Z')
const NOW = new Date('2026-08-24T12:00:00.000Z')

const CLAIM: OwnershipClaim = {
  submissionId: '11111111-1111-4111-8111-111111111111',
  hostname: 'shop.example.com',
  verifyToken: 'a'.repeat(48),
  tokenIssuedAt: ISSUED_AT,
}

/** A guarded reader that serves `body` at the well-known URL. */
function serving(body: string): (url: string) => Promise<SafeFetchResult> {
  return async (url) => ({ ok: true, status: 200, body, finalUrl: url })
}

const serving404: (url: string) => Promise<SafeFetchResult> = async () => ({
  ok: false,
  reason: 'http_status',
  detail: 'HTTP 404',
})

const noTxt = async (): Promise<string[][]> => []

describe('proof derivation', () => {
  it('is stable for the same claim and secret', () => {
    expect(deriveOwnershipProof(CLAIM, SECRET)).toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('changes when the verify token changes', () => {
    const other = { ...CLAIM, verifyToken: 'b'.repeat(48) }
    expect(deriveOwnershipProof(other, SECRET)).not.toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('changes when the hostname changes — the proof is domain-bound', () => {
    const other = { ...CLAIM, hostname: 'victim.example.org' }
    expect(deriveOwnershipProof(other, SECRET)).not.toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('changes when the submission id changes — the proof is claim-bound', () => {
    const other = { ...CLAIM, submissionId: '22222222-2222-4222-8222-222222222222' }
    expect(deriveOwnershipProof(other, SECRET)).not.toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('changes when the server secret changes — the proof is unforgeable without it', () => {
    expect(deriveOwnershipProof(CLAIM, 'another-secret')).not.toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('never leaks the secret into the payload', () => {
    expect(expectedProofPayload(CLAIM, SECRET)).not.toContain(SECRET)
  })

  it('treats a trailing-dot / uppercase hostname as the same domain', () => {
    const equivalent = { ...CLAIM, hostname: 'Shop.Example.COM.' }
    expect(deriveOwnershipProof(equivalent, SECRET)).toBe(deriveOwnershipProof(CLAIM, SECRET))
  })

  it('fits a DNS TXT record (255-byte string limit)', () => {
    expect(expectedProofPayload(CLAIM, SECRET).length).toBeLessThan(255)
  })
})

describe('published locations', () => {
  it('puts the unguessable token in the well-known filename', () => {
    expect(wellKnownPath(CLAIM)).toBe(`/.well-known/haven-verify-${CLAIM.verifyToken}.txt`)
    expect(wellKnownUrl(CLAIM)).toBe(`https://shop.example.com/.well-known/haven-verify-${CLAIM.verifyToken}.txt`)
  })

  it('always builds an https well-known URL', () => {
    expect(wellKnownUrl(CLAIM).startsWith('https://')).toBe(true)
  })

  it('names the TXT record under the claimed host', () => {
    expect(dnsTxtName(CLAIM)).toBe('_haven-verify.shop.example.com')
  })

  it('surfaces both methods plus an expiry in the submitter instructions', () => {
    const instructions = ownershipInstructions(CLAIM, SECRET)
    expect(instructions.well_known.content).toBe(expectedProofPayload(CLAIM, SECRET))
    expect(instructions.dns_txt.value).toBe(expectedProofPayload(CLAIM, SECRET))
    expect(instructions.expires_at).toBe(tokenExpiresAt(CLAIM).toISOString())
    expect(instructions.well_known.content.startsWith(OWNERSHIP_PAYLOAD_PREFIX)).toBe(true)
  })
})

describe('token lifetime', () => {
  it('expires exactly one TTL after issue', () => {
    expect(tokenExpiresAt(CLAIM).getTime()).toBe(ISSUED_AT.getTime() + TOKEN_TTL_MS)
  })

  it('is live inside the window and dead at the boundary', () => {
    expect(isTokenExpired(CLAIM, new Date(ISSUED_AT.getTime() + TOKEN_TTL_MS - 1))).toBe(false)
    expect(isTokenExpired(CLAIM, new Date(ISSUED_AT.getTime() + TOKEN_TTL_MS))).toBe(true)
  })
})

describe('verifyDomainOwnership — the happy paths', () => {
  it('verifies a correct well-known proof and records WHEN it was proven', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(expectedProofPayload(CLAIM, SECRET)),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toEqual({ ok: true, method: 'well-known', verifiedAt: NOW })
  })

  it('tolerates a trailing newline and surrounding blank lines in the served file', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(`\r\n  ${expectedProofPayload(CLAIM, SECRET)}  \r\n\r\n`),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'well-known' })
  })

  it('falls back to DNS TXT when the file is absent', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => [[expectedProofPayload(CLAIM, SECRET)]],
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'dns-txt' })
  })

  it('reassembles a TXT record the resolver split at 255 bytes', async () => {
    const payload = expectedProofPayload(CLAIM, SECRET)
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => [[payload.slice(0, 40), payload.slice(40)]],
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'dns-txt' })
  })

  it('accepts the proof among unrelated TXT records at the same name', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => [['v=spf1 -all'], [expectedProofPayload(CLAIM, SECRET)]],
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'dns-txt' })
  })

  it('is idempotent — verifying twice inside the lifetime succeeds twice', async () => {
    // The deliberate choice (see the module header): a transient failure must
    // not permanently burn a merchant's proof. Once-only-ness belongs to the
    // repository's `WHERE status = 'submitted'` transition guard, not here.
    const deps = { fetchText: serving(expectedProofPayload(CLAIM, SECRET)), resolveTxt: noTxt, now: NOW }
    expect(await verifyDomainOwnership(CLAIM, SECRET, deps)).toMatchObject({ ok: true })
    expect(await verifyDomainOwnership(CLAIM, SECRET, deps)).toMatchObject({ ok: true })
  })
})

describe('verifyDomainOwnership — the refusals that make it a proof', () => {
  it('refuses a proof computed from a DIFFERENT verify token', async () => {
    // Replay across submissions: the attacker publishes a payload that was
    // genuinely valid for an earlier token on this very host.
    const stale = deriveOwnershipProof({ ...CLAIM, verifyToken: 'b'.repeat(48) }, SECRET)
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(`${OWNERSHIP_PAYLOAD_PREFIX}v1.${CLAIM.submissionId}.${stale}`),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_mismatch' })
  })

  it('refuses a proof computed for a DIFFERENT domain', async () => {
    // Cross-domain replay: the attacker owns attacker.example.net, gets a
    // valid proof for it, and serves that exact payload while claiming
    // shop.example.com. The hostname is inside the MAC, so it does not verify.
    const foreign = expectedProofPayload({ ...CLAIM, hostname: 'attacker.example.net' }, SECRET)
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(foreign),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_mismatch' })
  })

  it('refuses a proof computed for a DIFFERENT submission id on the same host', async () => {
    const foreign = expectedProofPayload(
      { ...CLAIM, submissionId: '33333333-3333-4333-8333-333333333333' },
      SECRET,
    )
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(foreign),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_mismatch' })
  })

  it('refuses an expired token, without making any outbound request', async () => {
    // Two claims in one: the verdict is a refusal, AND an expired claim can
    // never be used to make Haven emit traffic at a chosen host.
    const fetchText = vi.fn(serving(expectedProofPayload(CLAIM, SECRET)))
    const resolveTxt = vi.fn(noTxt)
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText,
      resolveTxt,
      now: new Date(ISSUED_AT.getTime() + TOKEN_TTL_MS + 1),
    })
    expect(result).toMatchObject({ ok: false, reason: 'token_expired' })
    expect(fetchText).not.toHaveBeenCalled()
    expect(resolveTxt).not.toHaveBeenCalled()
  })

  it('refuses a proof forged under a different secret', async () => {
    const forged = expectedProofPayload(CLAIM, 'attacker-guessed-secret')
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(forged),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_mismatch' })
  })

  it('refuses when the token alone is echoed back instead of the proof', async () => {
    // A host that reflects its own path, or a naive merchant who pastes the
    // token, proves nothing — the proof is not the token.
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving(CLAIM.verifyToken),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_mismatch' })
  })

  it('refuses when nothing is published anywhere', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving404,
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_not_found' })
  })

  it('fails CLOSED when the ownership secret is unset, and makes no request', async () => {
    const fetchText = vi.fn(serving(expectedProofPayload(CLAIM, SECRET)))
    const result = await verifyDomainOwnership(CLAIM, '', { fetchText, resolveTxt: noTxt, now: NOW })
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('refuses when the guard itself blocked the target, and says so', async () => {
    // The SSRF guard's refusal must reach the persisted reason rather than
    // being flattened into a generic "not found".
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: async () => ({ ok: false, reason: 'address_not_public', detail: 'ipv4-link-local' }),
      resolveTxt: noTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_not_found' })
    expect((result as { attempts: { detail: string }[] }).attempts[0]!.detail).toContain('address_not_public')
  })

  it('survives a DNS lookup that throws', async () => {
    const result = await verifyDomainOwnership(CLAIM, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => {
        throw new Error('ENOTFOUND')
      },
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'proof_not_found' })
  })

  it('reads the well-known file through the guard at the claimed https host only', async () => {
    const fetchText = vi.fn(serving('nope'))
    await verifyDomainOwnership(CLAIM, SECRET, { fetchText, resolveTxt: noTxt, now: NOW })
    expect(fetchText).toHaveBeenCalledWith(
      `https://shop.example.com/.well-known/haven-verify-${CLAIM.verifyToken}.txt`,
    )
  })
})
