/**
 * SSRF guard tests (epic #1717, #1712).
 *
 * These are pure-unit by construction: the guard's two I/O seams (address
 * resolution and the pinned transport) are injected, so every policy decision
 * is exercised without a network and without a database. Nothing here mocks a
 * collaborator this slice owns — the resolver and the socket are exactly the
 * collaborators a test must not reach for real.
 *
 * The bar these tests are written to: a guard that has never been shown to say
 * NO is not a guard. Most of this file is refusals.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  assertSafeUrl,
  ipLiteralRange,
  resolvePublicAddresses,
  safeGetText,
  safePostJson,
  type PinnedRequest,
  type PinnedResponse,
  type PinnedTransport,
  type ResolvedAddress,
} from '../ssrf-guard.js'
import { isLocallyBoundHostname, isPublicUnicastAddress } from '../ip-classification.js'

const publicResolver = async (): Promise<ResolvedAddress[]> => [{ address: '93.184.216.34', family: 4 }]

function transportReturning(response: PinnedResponse): PinnedTransport {
  return async () => response
}

describe('isPublicUnicastAddress', () => {
  it.each([
    ['127.0.0.1', 'ipv4-loopback'],
    ['127.255.255.254', 'ipv4-loopback'],
    ['10.0.0.7', 'ipv4-private'],
    ['172.16.0.1', 'ipv4-private'],
    ['172.31.255.255', 'ipv4-private'],
    ['192.168.1.1', 'ipv4-private'],
    ['0.0.0.0', 'ipv4-this-network'],
    ['100.64.0.1', 'ipv4-cgnat'],
    ['198.18.0.1', 'ipv4-benchmark'],
    ['224.0.0.1', 'ipv4-multicast'],
    ['255.255.255.255', 'ipv4-reserved'],
    ['::1', 'ipv6-loopback'],
    ['::', 'ipv6-unspecified'],
    ['fd00::1', 'ipv6-unique-local'],
    ['fc00::1', 'ipv6-unique-local'],
    ['fe80::1', 'ipv6-link-local'],
    ['ff02::1', 'ipv6-multicast'],
    ['2001:db8::1', 'ipv6-documentation'],
  ])('refuses %s as %s', (address, range) => {
    const verdict = isPublicUnicastAddress(address)
    expect(verdict.allowed).toBe(false)
    expect(verdict.range).toBe(range)
  })

  it('refuses the cloud instance-metadata address 169.254.169.254', () => {
    // The single address SSRF exists to reach. Named on its own so a
    // regression in the link-local range is unmistakable in the failure output.
    expect(isPublicUnicastAddress('169.254.169.254')).toEqual({
      allowed: false,
      range: 'ipv4-link-local',
    })
  })

  it('refuses IPv4-mapped IPv6 loopback, which walks past every IPv6 range check', () => {
    // ::ffff:127.0.0.1 and its hex spelling are the same address. A guard that
    // only string-matches "127." or "::1" lets both through.
    expect(isPublicUnicastAddress('::ffff:127.0.0.1').allowed).toBe(false)
    expect(isPublicUnicastAddress('::ffff:7f00:1').allowed).toBe(false)
    expect(isPublicUnicastAddress('::ffff:169.254.169.254').range).toBe('ipv6-mapped-ipv4-link-local')
  })

  it('refuses NAT64 and 6to4 encapsulations of private space', () => {
    expect(isPublicUnicastAddress('64:ff9b::10.0.0.1').allowed).toBe(false)
    expect(isPublicUnicastAddress('2002:7f00:1::1').allowed).toBe(false)
  })

  it('refuses anything it cannot parse, rather than guessing', () => {
    expect(isPublicUnicastAddress('not-an-ip').range).toBe('unparseable')
    expect(isPublicUnicastAddress('').range).toBe('unparseable')
  })

  it('allows genuine public unicast addresses', () => {
    expect(isPublicUnicastAddress('93.184.216.34').allowed).toBe(true)
    expect(isPublicUnicastAddress('8.8.8.8').allowed).toBe(true)
    expect(isPublicUnicastAddress('2606:4700:4700::1111').allowed).toBe(true)
  })
})

describe('isLocallyBoundHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'foo.localhost', 'db.local', 'vault.internal', 'metadata'])(
    'refuses %s',
    (host) => {
      expect(isLocallyBoundHostname(host)).toBe(true)
    },
  )

  it('allows an ordinary merchant hostname', () => {
    expect(isLocallyBoundHostname('shop.example.com')).toBe(false)
  })
})

describe('ipLiteralRange — the predicate BOTH ownership paths consult (#1959)', () => {
  it.each([
    ['1.2.3.4', 'public-unicast'],
    ['93.184.216.34', 'public-unicast'],
    ['127.0.0.1', 'ipv4-loopback'],
    ['169.254.169.254', 'ipv4-link-local'],
    ['10.0.0.7', 'ipv4-private'],
    ['::1', 'ipv6-loopback'],
    ['[::1]', 'ipv6-loopback'],
  ])('classifies %s as the IP literal it is', (host, range) => {
    expect(ipLiteralRange(host)).toBe(range)
  })

  it.each(['shop.example.com', 'a.co', 'xn--bcher-kva.example.com', '1.2.3.4.example.com', 'localhost'])(
    'says %s is a NAME, not a literal',
    (host) => {
      // The positive control: a predicate that answers "literal" to everything
      // would pass every refusal test in this file and reject every merchant.
      expect(ipLiteralRange(host)).toBeNull()
    },
  )

  it('is the ONE source of assertSafeUrl\'s IP-literal refusal, so the two cannot drift', () => {
    for (const host of ['1.2.3.4', '127.0.0.1', '169.254.169.254']) {
      const range = ipLiteralRange(host)
      expect(range).not.toBeNull()
      const verdict = assertSafeUrl(`https://${host}/x`)
      expect(verdict).toMatchObject({ ok: false, reason: 'host_not_public' })
      // The guard's detail is built from this function's range, not a second copy.
      expect((verdict as { detail: string }).detail).toContain(range as string)
    }
  })
})

describe('assertSafeUrl', () => {
  it('accepts a plain https merchant URL', () => {
    const result = assertSafeUrl('https://shop.example.com/.well-known/haven-verify-abc.txt')
    expect(result.ok).toBe(true)
  })

  it('refuses http, because the proof leans on TLS for host authentication', () => {
    const result = assertSafeUrl('http://shop.example.com/x')
    expect(result).toMatchObject({ ok: false, reason: 'scheme_not_https' })
  })

  it.each(['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/'])(
    'refuses the non-https scheme in %s',
    (url) => {
      expect(assertSafeUrl(url)).toMatchObject({ ok: false, reason: 'scheme_not_https' })
    },
  )

  it('refuses embedded credentials', () => {
    expect(assertSafeUrl('https://user:pw@example.com/x')).toMatchObject({
      ok: false,
      reason: 'embedded_credentials',
    })
  })

  it('refuses a non-default port, so the guard is not a port scanner', () => {
    expect(assertSafeUrl('https://example.com:8080/x')).toMatchObject({
      ok: false,
      reason: 'non_default_port',
    })
    expect(assertSafeUrl('https://example.com:443/x').ok).toBe(true)
  })

  it('refuses IP literals outright — an address cannot claim a domain', () => {
    expect(assertSafeUrl('https://93.184.216.34/x')).toMatchObject({ ok: false, reason: 'host_not_public' })
    expect(assertSafeUrl('https://127.0.0.1/x')).toMatchObject({ ok: false, reason: 'host_not_public' })
    expect(assertSafeUrl('https://[::1]/x')).toMatchObject({ ok: false, reason: 'host_not_public' })
  })

  it('refuses locally-bound hostnames', () => {
    expect(assertSafeUrl('https://localhost/x')).toMatchObject({ ok: false, reason: 'host_not_public' })
  })
})

describe('resolvePublicAddresses', () => {
  it('refuses a hostname whose A record points into private space (the rebinding gap)', async () => {
    // This is what a hostname REGEX cannot catch: the name looks public and
    // the address does not. `evil.example.com A 169.254.169.254` is a legal
    // DNS record anyone can publish for a domain they own.
    const result = await resolvePublicAddresses('evil.example.com', async () => [
      { address: '169.254.169.254', family: 4 },
    ])
    expect(result).toMatchObject({ ok: false, reason: 'address_not_public' })
    expect((result as { detail: string }).detail).toContain('ipv4-link-local')
  })

  it('refuses when EVERY address is blocked, even with several', async () => {
    const result = await resolvePublicAddresses('evil.example.com', async () => [
      { address: '10.0.0.1', family: 4 },
      { address: 'fd00::1', family: 6 },
    ])
    expect(result).toMatchObject({ ok: false, reason: 'address_not_public' })
  })

  it('keeps only the public addresses when a host mixes them', async () => {
    const result = await resolvePublicAddresses('mixed.example.com', async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ])
    expect(result.ok).toBe(true)
    expect((result as { addresses: ResolvedAddress[] }).addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
    ])
  })

  it('refuses a host that resolves to nothing', async () => {
    const result = await resolvePublicAddresses('void.example.com', async () => [])
    expect(result).toMatchObject({ ok: false, reason: 'dns_failure' })
  })

  it('refuses when resolution throws', async () => {
    const result = await resolvePublicAddresses('nx.example.com', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(result).toMatchObject({ ok: false, reason: 'dns_failure' })
  })
})

describe('safeGetText', () => {
  it('returns the body of a clean 200', async () => {
    const result = await safeGetText('https://shop.example.com/.well-known/x.txt', {
      resolver: publicResolver,
      transport: transportReturning({ status: 200, location: null, body: 'hello' }),
    })
    expect(result).toMatchObject({ ok: true, body: 'hello' })
  })

  it('pins the transport to the address that was validated, not to the hostname', async () => {
    // The pinning property in one assertion: whatever the transport connects
    // to must be the address resolution already cleared.
    const transport = vi.fn<PinnedTransport>(async () => ({ status: 200, location: null, body: 'ok' }))
    await safeGetText('https://shop.example.com/x', {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]![0]).toMatchObject({ address: '93.184.216.34', family: 4 })
  })

  it('never calls the transport when the URL policy already refuses', async () => {
    const transport = vi.fn<PinnedTransport>(async () => ({ status: 200, location: null, body: 'ok' }))
    const result = await safeGetText('http://shop.example.com/x', { resolver: publicResolver, transport })
    expect(result).toMatchObject({ ok: false, reason: 'scheme_not_https' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('never calls the transport when resolution lands in blocked space', async () => {
    const transport = vi.fn<PinnedTransport>(async () => ({ status: 200, location: null, body: 'ok' }))
    const result = await safeGetText('https://evil.example.com/x', {
      resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      transport,
    })
    expect(result).toMatchObject({ ok: false, reason: 'address_not_public' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a redirect that leaves https', async () => {
    let hop = 0
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      transport: async () => {
        hop += 1
        return hop === 1
          ? { status: 302, location: 'http://shop.example.com/x', body: '' }
          : { status: 200, location: null, body: 'leaked' }
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'scheme_not_https' })
  })

  it('refuses a redirect to the metadata endpoint — the classic SSRF pivot', async () => {
    // A merchant front door that answers 302 to 169.254.169.254 is the whole
    // reason redirects are re-validated instead of followed.
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: async (hostname) =>
        hostname === 'shop.example.com'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }],
      transport: async (req) =>
        req.url.hostname === 'shop.example.com'
          ? { status: 302, location: 'https://metadata.example.com/latest/meta-data/', body: '' }
          : { status: 200, location: null, body: 'AWS CREDENTIALS' },
    })
    expect(result).toMatchObject({ ok: false, reason: 'address_not_public' })
  })

  it('follows a same-scheme redirect to a public host', async () => {
    let hop = 0
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      transport: async () => {
        hop += 1
        return hop === 1
          ? { status: 301, location: 'https://www.shop.example.com/x', body: '' }
          : { status: 200, location: null, body: 'proof' }
      },
    })
    expect(result).toMatchObject({ ok: true, body: 'proof', finalUrl: 'https://www.shop.example.com/x' })
  })

  it('refuses once the redirect budget is exhausted', async () => {
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      maxRedirects: 2,
      transport: async () => ({ status: 302, location: 'https://shop.example.com/loop', body: '' }),
    })
    expect(result).toMatchObject({ ok: false, reason: 'redirect_budget' })
  })

  it('refuses a redirect with no Location header', async () => {
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      transport: transportReturning({ status: 302, location: null, body: '' }),
    })
    expect(result).toMatchObject({ ok: false, reason: 'redirect_missing_location' })
  })

  it('refuses a non-200 status', async () => {
    const result = await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      transport: transportReturning({ status: 404, location: null, body: 'nope' }),
    })
    expect(result).toMatchObject({ ok: false, reason: 'http_status' })
  })

  it('passes a byte cap down to the transport', async () => {
    const transport = vi.fn<PinnedTransport>(async () => ({ status: 200, location: null, body: 'ok' }))
    await safeGetText('https://shop.example.com/x', {
      resolver: publicResolver,
      transport,
      maxBytes: 1024,
    })
    expect(transport.mock.calls[0]![0]!.maxBytes).toBe(1024)
  })
})

describe('safePostJson (#1713)', () => {
  const okJson: PinnedResponse = { status: 200, location: null, body: '{"jsonrpc":"2.0"}' }

  it('sends the JSON body and the JSON-RPC content type on a POST', async () => {
    const seen: PinnedRequest[] = []
    const transport: PinnedTransport = async (req) => {
      seen.push(req)
      return okJson
    }
    await safePostJson('https://merchant.example/mcp', { jsonrpc: '2.0', id: 1 }, {
      resolver: publicResolver,
      transport,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.body).toBe('{"jsonrpc":"2.0","id":1}')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
  })

  it('RETURNS a 402 instead of refusing it — the challenge is the wanted result', async () => {
    // safeGetText refuses every non-200; the probe's whole purpose is to read
    // one. If this ever starts refusing, #1713 silently verifies nothing.
    const result = await safePostJson('https://merchant.example/mcp', {}, {
      resolver: publicResolver,
      transport: transportReturning({ status: 402, location: null, body: '{"payment_required":{}}' }),
    })
    expect(result.ok).toBe(true)
    expect((result as { status: number }).status).toBe(402)
  })

  it('REFUSES to follow a redirect on a POST, even to a perfectly public host', async () => {
    // Address classification cannot see this one: the victim is an ordinary
    // public host. Following it would make the guard a request forwarder with
    // an attacker-chosen body and an attacker-chosen target.
    const transport = vi.fn<PinnedTransport>(async () => ({
      status: 307,
      location: 'https://victim.example/ingest',
      body: '',
    }))
    const result = await safePostJson('https://merchant.example/mcp', { a: 1 }, {
      resolver: publicResolver,
      transport,
      // A DELIBERATELY PERMISSIVE budget. The refusal must not depend on a
      // caller passing `maxRedirects: 0` — callers that pass one are relying
      // on an option that never gets consulted, because this branch fires
      // first. Raising the budget here is what proves that.
      maxRedirects: 5,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toBe('redirect_on_post')
    // And exactly one request left the building — no second hop was attempted
    // even though five were budgeted.
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('still refuses a POST to private space before any packet leaves', async () => {
    const transport = vi.fn<PinnedTransport>(async () => okJson)
    const result = await safePostJson('https://internal.example/mcp', {}, {
      resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      transport,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toBe('address_not_public')
    expect(transport).not.toHaveBeenCalled()
  })

  it('carries an allowlisted caller header and DROPS everything else', async () => {
    const seen: PinnedRequest[] = []
    await safePostJson('https://merchant.example/mcp', {}, {
      resolver: publicResolver,
      transport: async (req) => {
        seen.push(req)
        return okJson
      },
      extraHeaders: {
        'mcp-session-id': 'sess-123',
        authorization: 'Bearer stolen',
        host: 'victim.example',
        'content-type': 'text/plain',
      },
    })
    expect(seen[0]!.headers['mcp-session-id']).toBe('sess-123')
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.headers.host).toBeUndefined()
    // The guard's own content-type is not overridable by a caller.
    expect(seen[0]!.headers['content-type']).toBe('application/json')
  })

  it('drops an allowlisted header whose value carries CRLF — header injection', async () => {
    const seen: PinnedRequest[] = []
    await safePostJson('https://merchant.example/mcp', {}, {
      resolver: publicResolver,
      transport: async (req) => {
        seen.push(req)
        return okJson
      },
      extraHeaders: { 'mcp-session-id': 'ok\r\nx-injected: yes' },
    })
    expect(seen[0]!.headers['mcp-session-id']).toBeUndefined()
  })

  it('exposes lowercased response headers, so the caller can read mcp-session-id', async () => {
    const result = await safePostJson('https://merchant.example/mcp', {}, {
      resolver: publicResolver,
      transport: transportReturning({
        status: 200,
        location: null,
        body: '{}',
        headers: { 'mcp-session-id': 'sess-9' },
      }),
    })
    expect((result as { headers: Record<string, string> }).headers['mcp-session-id']).toBe('sess-9')
  })
})
