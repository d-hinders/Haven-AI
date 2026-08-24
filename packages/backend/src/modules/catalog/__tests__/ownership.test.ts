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
import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import {
  OWNERSHIP_PAYLOAD_PREFIX,
  TOKEN_TTL_MS,
  deriveOwnershipProof,
  dnsTxtName,
  expectedProofPayload,
  isTokenExpired,
  isValidHostname,
  isValidSubmissionId,
  isValidVerifyToken,
  ownershipInstructions,
  tokenExpiresAt,
  verifyDomainOwnership,
  wellKnownPath,
  wellKnownUrl,
  type OwnershipClaim,
} from '../ownership.js'
import { assertSafeUrl, type SafeFetchResult } from '../../../infra/http/ssrf-guard.js'

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
  // `headers` became part of the guarded response with #1713 (MCP session id
  // + the `payment-required` challenge header); the ownership proof reads none
  // of them, so an empty record is the honest fixture.
  return async (url) => ({ ok: true, status: 200, body, headers: {}, finalUrl: url })
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

describe('hostname grammar backstop', () => {
  it.each([
    ['shop.example.com', true],
    ['a.co', true],
    ['xn--bcher-kva.example.com', true],
    ['sub.domain.shop.example.com', true],
    ['shop.example.com.', true],
    ['SHOP.EXAMPLE.COM', true],
    ['localhost', false],
    ['', false],
    ['shop..example.com', false],
    ['-shop.example.com', false],
    ['shop-.example.com', false],
    ['shop.example.com/evil', false],
    ['shop.example.com:443', false],
    ['bücher.example.com', false],
    ['shop example.com', false],
    ['123.456', false],
    ['shop.example.123', false],
  ])('%s -> %s', (host, expected) => {
    expect(isValidHostname(host)).toBe(expected)
  })

  it('rejects an embedded newline, which WHATWG URL would silently STRIP', () => {
    // The concrete defect: `new URL('https://evil.com\n.attacker.net/')` does
    // not throw — it yields host `evil.com.attacker.net`. Without this check
    // the string fed to the MAC and persisted as "the verified domain" is not
    // the string that was network-verified.
    expect(isValidHostname('evil.com\n.attacker.net')).toBe(false)
    expect(new URL('https://evil.com\n.attacker.net/').hostname).toBe('evil.com.attacker.net')
  })

  it.each([
    ['tab', 'evil.com\t.attacker.net'],
    ['carriage return', 'evil.com\r.attacker.net'],
    ['NUL', 'evil.com\u0000.attacker.net'],
    ['C1 control', 'evil.com\u0085.attacker.net'],
  ])('rejects a hostname carrying a %s character', (_label, host) => {
    expect(isValidHostname(host)).toBe(false)
  })

  it.each([
    ['hex IPv4', '0xa9.0xfe.0xa9.0xfe', '169.254.169.254'],
    ['hex loopback', '0x7f.0x0.0x0.0x1', '127.0.0.1'],
    ['octal IPv4', '0177.0.0.1', '127.0.0.1'],
  ])('refuses the %s disguise, which URL canonicalization rewrites', (_l, host, canonical) => {
    // The general rule, not a fourth patch: the round-trip check refuses ANY
    // host the URL parser rewrites, including spellings nobody has found yet.
    expect(new URL(`https://${host}/x`).hostname).toBe(canonical)
    expect(isValidHostname(host)).toBe(false)
  })

  it('accepts only hostnames that survive URL canonicalization byte-identically', () => {
    for (const host of ['shop.example.com', 'a.co', 'xn--bcher-kva.example.com', 'sub.deep.example.org']) {
      expect(new URL(`https://${host}/x`).hostname).toBe(host)
      expect(isValidHostname(host)).toBe(true)
    }
  })

  it('refuses an all-numeric final label, which WHATWG URL reads as an IPv4 literal', () => {
    // `new URL('https://123.456/x')` canonicalizes the host to 123.0.1.200
    // with no DNS involved. `assertSafeUrl` would also catch it as an IP
    // literal — this rule exists so the invariant does not depend on that
    // second, independent guard doing the work.
    expect(new URL('https://123.456/x').hostname).toBe('123.0.1.200')
    expect(isValidHostname('123.456')).toBe(false)
  })

  it('refuses to derive a proof for a malformed hostname at all', () => {
    expect(() => deriveOwnershipProof({ ...CLAIM, hostname: 'evil.com\n.attacker.net' }, SECRET)).toThrow()
  })

  it('never echoes the rejected hostname into the error message', () => {
    // The value is attacker-supplied and the message may reach a log.
    try {
      deriveOwnershipProof({ ...CLAIM, hostname: 'evil.com\n.attacker.net' }, SECRET)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('attacker.net')
    }
  })

  it('refuses a malformed hostname without making any outbound request', async () => {
    const fetchText = vi.fn(serving('anything'))
    const resolveTxt = vi.fn(noTxt)
    const result = await verifyDomainOwnership(
      { ...CLAIM, hostname: 'evil.com\n.attacker.net' },
      SECRET,
      { fetchText, resolveTxt, now: NOW },
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid_hostname' })
    expect(fetchText).not.toHaveBeenCalled()
    expect(resolveTxt).not.toHaveBeenCalled()
  })
})

describe('IP-literal hostnames are refused at CLAIM level, not only at URL level (#1959)', () => {
  /**
   * The gap this block pins. `isValidHostname`'s URL round-trip catches every
   * host the parser REWRITES; an already-canonical dotted-decimal IPv4 is not
   * rewritten, so it survived. The well-known path still refused it — via
   * `assertSafeUrl`, one layer down — but `dnsTxtName` builds no URL, so the
   * DNS-TXT path had no equivalent refusal and could reach `ok: true`.
   *
   * These names are load-bearing; a mutation must show up unambiguously:
   *
   *   'the DNS-TXT path refuses an IP-literal host that would OTHERWISE verify'
   *   'refuses a canonical dotted-decimal IPv4 host, which the URL round-trip does NOT catch'
   */
  const ipClaim: OwnershipClaim = { ...CLAIM, hostname: '1.2.3.4' }

  it('refuses a canonical dotted-decimal IPv4 host, which the URL round-trip does NOT catch', () => {
    // Both halves matter. The first shows WHY the round-trip cannot cover this
    // case; without it the second is just an assertion with no explanation.
    expect(new URL('https://1.2.3.4/x').hostname).toBe('1.2.3.4')
    expect(isValidHostname('1.2.3.4')).toBe(false)
  })

  it.each(['1.2.3.4', '93.184.216.34', '127.0.0.1', '169.254.169.254', '10.0.0.7', '0.0.0.0'])(
    'refuses the IP literal %s as an ownership claim',
    (host) => {
      expect(isValidHostname(host)).toBe(false)
    },
  )

  /**
   * The proof this module now REFUSES to derive, derived independently.
   *
   * `expectedProofPayload(ipClaim, …)` throws — that is the fix. So the only
   * way to build the input that would have verified is to recompute the MAC
   * here, from the format the module docstring specifies. The duplication is
   * the point of the test, not an accident of it: without it the "decisive"
   * assertion below only proves the resolver was not called, which a rig
   * holding a proof bound to a DIFFERENT hostname would satisfy for the wrong
   * reason. (It did, on the first draft, and the mutation run caught it.)
   */
  function proofPayloadForIpClaim(): string {
    const message = ['haven-domain-ownership', 'v1', ipClaim.submissionId, '1.2.3.4', ipClaim.verifyToken].join('\n')
    const mac = createHmac('sha256', SECRET).update(message, 'utf8').digest('base64url')
    return `${OWNERSHIP_PAYLOAD_PREFIX}v1.${ipClaim.submissionId}.${mac}`
  }

  it('the DNS-TXT path refuses an IP-literal host that would OTHERWISE verify', async () => {
    // The decisive test, and the one the whole issue is about. The resolver is
    // rigged to answer with a CORRECT, claim-bound proof for THIS exact claim,
    // and the well-known path is rigged to fail — so the only thing standing
    // between this claim and `ok: true, method: 'dns-txt'` is the claim-level
    // refusal. Deleting that refusal makes this go green in the worst way, and
    // that is exactly what the mutation run must show.
    const fetchText = vi.fn(serving404)
    const resolveTxt = vi.fn(async () => [[proofPayloadForIpClaim()]])

    const result = await verifyDomainOwnership(ipClaim, SECRET, { fetchText, resolveTxt, now: NOW })

    expect(result).toMatchObject({ ok: false, reason: 'invalid_hostname' })
    expect(resolveTxt).not.toHaveBeenCalled()
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('the rig is REAL — the same proof verifies for the same claim on a domain host', async () => {
    // Guards the guard's evidence. If this ever fails, the test above stopped
    // proving anything: its resolver answer would be a proof that could not
    // have verified anyway, and the refusal would be unfalsifiable.
    const domainClaim = { ...CLAIM, hostname: 'shop.example.com' }
    const message = ['haven-domain-ownership', 'v1', domainClaim.submissionId, 'shop.example.com', domainClaim.verifyToken].join('\n')
    const mac = createHmac('sha256', SECRET).update(message, 'utf8').digest('base64url')
    const payload = `${OWNERSHIP_PAYLOAD_PREFIX}v1.${domainClaim.submissionId}.${mac}`
    expect(payload).toBe(expectedProofPayload(domainClaim, SECRET))

    const result = await verifyDomainOwnership(domainClaim, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => [[payload]],
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'dns-txt' })
  })

  it('says WHY in the detail, so the verdict is not indistinguishable from a typo', () => {
    // `reason` is deliberately not a new enum member (#1711's status route
    // would have to learn a value meaning the same thing); the detail carries
    // the distinction instead.
    return verifyDomainOwnership(ipClaim, SECRET, {
      fetchText: vi.fn(serving404),
      resolveTxt: vi.fn(noTxt),
      now: NOW,
    }).then((result) => {
      expect(result).toMatchObject({ ok: false, reason: 'invalid_hostname' })
      expect((result as { detail: string }).detail).toContain('IP literal')
      expect((result as { detail: string }).detail).toContain('public-unicast')
    })
  })

  it('refuses to build the DNS TXT name for an IP-literal host', () => {
    // `dnsTxtName` is an exported entry point of its own — a neighbouring
    // slice can reach the DNS path without going through verifyDomainOwnership.
    expect(() => dnsTxtName(ipClaim)).toThrow()
  })

  it('refuses to derive a proof, build a URL, or issue instructions for an IP-literal host', () => {
    expect(() => deriveOwnershipProof(ipClaim, SECRET)).toThrow()
    expect(() => wellKnownUrl(ipClaim)).toThrow()
    expect(() => ownershipInstructions(ipClaim, SECRET)).toThrow()
  })

  it('agrees with assertSafeUrl on every literal — one predicate, both paths', () => {
    // The asymmetry itself, pinned. Before #1959 the right-hand column was
    // `true` for canonical IPv4 while the left refused: the module's rule was
    // a property of one path. This test fails if they ever diverge again.
    for (const host of ['1.2.3.4', '93.184.216.34', '127.0.0.1', '169.254.169.254']) {
      expect(assertSafeUrl(`https://${host}/x`)).toMatchObject({ ok: false, reason: 'host_not_public' })
      expect(isValidHostname(host)).toBe(false)
    }
  })

  it('still accepts a real domain whose labels merely LOOK numeric', async () => {
    // The positive control. A guard that refuses everything is not a guard,
    // and "four numeric labels" is not the rule — "parses as an address" is.
    expect(isValidHostname('1.2.3.4.example.com')).toBe(true)
    expect(isValidHostname('shop.example.com')).toBe(true)
    // Not `1.2.3.4.5` — that one is refused, and NOT by this rule: WHATWG
    // tries an IPv4 parse on any all-numeric final label, fails on five parts,
    // and `new URL` throws, so the round-trip check already had it. Asserting
    // it here would credit the new guard with a refusal it does not make.

    // And it still verifies end to end, through the path the refusal guards.
    const claim = { ...CLAIM, hostname: '1.2.3.4.example.com' }
    const payload = expectedProofPayload(claim, SECRET)
    const result = await verifyDomainOwnership(claim, SECRET, {
      fetchText: serving404,
      resolveTxt: async () => [[payload]],
      now: NOW,
    })
    expect(result).toMatchObject({ ok: true, method: 'dns-txt' })
  })
})

describe('verify-token grammar backstop', () => {
  it.each([
    ['a'.repeat(48), true],
    ['A-Za-z0-9_-'.replace(/[^A-Za-z0-9_-]/g, '') + 'x'.repeat(16), true],
    ['short', false],
    ['', false],
    ['x'.repeat(129), false],
  ])('%s -> %s', (token, expected) => {
    expect(isValidVerifyToken(token)).toBe(expected)
  })

  it.each([
    ['path traversal', '../../../etc/passwd'],
    ['backslash traversal', 'abc\\..\\..\\x'],
    ['query string', 'abc?x=1'],
    ['host-swap attempt', 'abc/../../evil.example.net/x'],
    ['fragment', 'abc#frag'],
    ['whitespace', 'abc def'],
  ])('refuses a token carrying %s', (_label, token) => {
    expect(isValidVerifyToken(token)).toBe(false)
  })

  it('refuses to build a well-known path that ESCAPES the /.well-known/ prefix', () => {
    // Measured, not reasoned about: without this guard
    // `new URL('https://h/.well-known/haven-verify-../../../etc/passwd.txt')`
    // yields path `/etc/passwd.txt` — the URL fetched would not be the URL
    // `ownershipInstructions` told the merchant to serve.
    expect(new URL('https://h.example.com/.well-known/haven-verify-../../../etc/passwd.txt').pathname).toBe(
      '/etc/passwd.txt',
    )
    expect(() => wellKnownPath({ ...CLAIM, verifyToken: '../../../etc/passwd' })).toThrow()
  })

  it('refuses a hostile token in verifyDomainOwnership without any outbound request', async () => {
    const fetchText = vi.fn(serving('anything'))
    const resolveTxt = vi.fn(noTxt)
    const result = await verifyDomainOwnership({ ...CLAIM, verifyToken: 'abc?x=1' }, SECRET, {
      fetchText,
      resolveTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_token' })
    expect(fetchText).not.toHaveBeenCalled()
    expect(resolveTxt).not.toHaveBeenCalled()
  })

  it('never echoes the rejected token into the error message', () => {
    try {
      wellKnownPath({ ...CLAIM, verifyToken: 'abc/../../evil.example.net/x' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('evil.example.net')
    }
  })
})

describe('the URL-constructing exports defend themselves', () => {
  // They are the module's most reusable exports — #1711 wiring `wellKnownUrl`
  // into a diagnostics response is the obvious case — so reusing them off the
  // validated path must not reintroduce the newline or path-escape classes.
  it('wellKnownUrl rejects a malformed hostname', () => {
    expect(() => wellKnownUrl({ ...CLAIM, hostname: 'evil.com\n.attacker.net' })).toThrow()
  })

  it('dnsTxtName rejects a malformed hostname', () => {
    expect(() => dnsTxtName({ ...CLAIM, hostname: 'evil.com\n.attacker.net' })).toThrow()
  })

  it('wellKnownUrl rejects a hostile token', () => {
    expect(() => wellKnownUrl({ ...CLAIM, verifyToken: '../../../etc/passwd' })).toThrow()
  })
})

describe('submission-id trust boundary', () => {
  // Explicit decision, not silence: the MAC's five fields are `\n`-delimited
  // and the module's argument leans on submissionId not containing a newline.
  // That was validated for hostname and verifyToken but merely ASSUMED here,
  // about a slice (#1711) that is not merged.
  it.each([
    ['11111111-1111-4111-8111-111111111111', true],
    ['abc_123:x.y-z', true],
    ['', false],
    ['id\nwith-newline', false],
    ['id\u0000nul', false],
    ['id with space', false],
    ['x'.repeat(129), false],
  ])('%s -> %s', (id, expected) => {
    expect(isValidSubmissionId(id)).toBe(expected)
  })

  it('refuses a newline-bearing submission id without any outbound request', async () => {
    const fetchText = vi.fn(serving('anything'))
    const resolveTxt = vi.fn(noTxt)
    const result = await verifyDomainOwnership({ ...CLAIM, submissionId: 'a\nb' }, SECRET, {
      fetchText,
      resolveTxt,
      now: NOW,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_submission_id' })
    expect(fetchText).not.toHaveBeenCalled()
    expect(resolveTxt).not.toHaveBeenCalled()
  })

  it('refuses to derive a proof for a newline-bearing submission id', () => {
    expect(() => deriveOwnershipProof({ ...CLAIM, submissionId: 'a\nb' }, SECRET)).toThrow()
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
