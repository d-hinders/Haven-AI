/**
 * IP-literal classification for the outbound SSRF guard (epic #1717, #1712).
 *
 * This file is PURE: it parses an address to bytes and answers one question —
 * "may Haven open an outbound connection to this address?". It performs no
 * I/O, so every range below is directly unit-testable, which is the point.
 * `ssrf-guard.ts` is the only intended consumer; #1713's probe reaches it
 * through that guard rather than re-deriving these ranges.
 *
 * The default is DENY. `isPublicUnicastAddress` returns `allowed: true` only
 * for addresses that fall through every listed range, so a range this file has
 * never heard of is refused rather than permitted. That direction matters: a
 * missed range in a deny-list is an SSRF hole, while a missed range in an
 * allow-list is a merchant who cannot be verified — one is a security defect,
 * the other is a support ticket.
 */
import net from 'node:net'

export interface AddressVerdict {
  allowed: boolean
  /** Stable machine-readable range name; `'public-unicast'` when allowed. */
  range: string
}

const ALLOWED: AddressVerdict = { allowed: true, range: 'public-unicast' }

function deny(range: string): AddressVerdict {
  return { allowed: false, range }
}

/** Parse a dotted-quad into 4 bytes, or `null` when it is not IPv4. */
function parseIpv4(address: string): number[] | null {
  if (net.isIPv4(address) !== true) return null
  const parts = address.split('.').map((p) => Number(p))
  return parts.length === 4 ? parts : null
}

/**
 * Parse an IPv6 literal into 16 bytes. Handles `::` compression and the
 * dotted-quad tail form (`::ffff:1.2.3.4`) that IPv4-mapped addresses use —
 * the form an attacker reaches for first, since a naive string check for
 * `127.` or a naive check for `::1` each miss half of it.
 */
function parseIpv6(address: string): number[] | null {
  if (net.isIPv6(address) !== true) return null
  // Strip a zone index (`fe80::1%eth0`) before parsing.
  const bare = address.split('%')[0] ?? address

  // Rewrite a dotted-quad tail (`::ffff:1.2.3.4`) into the two hex groups it
  // denotes, so the rest of this function only ever sees a pure 8-group form.
  // Rewriting rather than special-casing keeps `::` compression working on the
  // remaining head — the combination that made an earlier version of this
  // parser place the `ffff` marker at the wrong byte offset and classify
  // `::ffff:127.0.0.1` as PUBLIC.
  let head = bare
  const lastColon = bare.lastIndexOf(':')
  const tail = bare.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (v4 === null) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    head = `${bare.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const [left, right] = head.includes('::') ? head.split('::') : [head, null]
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === undefined || right === null || right === '' ? [] : right.split(':')

  const fill = 8 - leftGroups.length - rightGroups.length
  if (right === null && fill !== 0) return null
  if (fill < 0) return null

  const groups = [...leftGroups, ...Array<string>(fill).fill('0'), ...rightGroups]
  const bytes: number[] = []
  for (const group of groups) {
    const value = Number.parseInt(group, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes.length === 16 ? bytes : null
}

function classifyIpv4(b: number[]): AddressVerdict {
  const [a, second, third] = b as [number, number, number, number]
  if (a === 0) return deny('ipv4-this-network')
  if (a === 10) return deny('ipv4-private')
  if (a === 127) return deny('ipv4-loopback')
  if (a === 100 && second >= 64 && second <= 127) return deny('ipv4-cgnat')
  // 169.254.0.0/16 — link-local, and the range holding the 169.254.169.254
  // cloud instance-metadata endpoint that SSRF exists to reach.
  if (a === 169 && second === 254) return deny('ipv4-link-local')
  if (a === 172 && second >= 16 && second <= 31) return deny('ipv4-private')
  if (a === 192 && second === 0 && third === 0) return deny('ipv4-ietf-protocol')
  if (a === 192 && second === 0 && third === 2) return deny('ipv4-documentation')
  if (a === 192 && second === 168) return deny('ipv4-private')
  if (a === 198 && (second === 18 || second === 19)) return deny('ipv4-benchmark')
  if (a === 198 && second === 51 && third === 100) return deny('ipv4-documentation')
  if (a === 203 && second === 0 && third === 113) return deny('ipv4-documentation')
  if (a >= 224 && a <= 239) return deny('ipv4-multicast')
  if (a >= 240) return deny('ipv4-reserved')
  return ALLOWED
}

function classifyIpv6(b: number[]): AddressVerdict {
  const isZeroPrefix = (n: number) => b.slice(0, n).every((byte) => byte === 0)

  // ::ffff:a.b.c.d — IPv4-mapped. Classify the embedded IPv4, or ::ffff:7f00:1
  // walks straight past every IPv6 range below and lands on loopback.
  if (isZeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) {
    const embedded = classifyIpv4(b.slice(12))
    return embedded.allowed ? deny('ipv6-mapped-ipv4') : deny(`ipv6-mapped-${embedded.range}`)
  }
  // 64:ff9b::/96 — NAT64. Same reasoning: it carries an embedded IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && isZeroPrefixFrom(b, 4, 12)) {
    const embedded = classifyIpv4(b.slice(12))
    return embedded.allowed ? deny('ipv6-nat64') : deny(`ipv6-nat64-${embedded.range}`)
  }
  // 2002::/16 — 6to4, embedded IPv4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return deny('ipv6-6to4')

  if (isZeroPrefix(15) && b[15] === 0) return deny('ipv6-unspecified')
  if (isZeroPrefix(15) && b[15] === 1) return deny('ipv6-loopback')
  if (b[0] === 0x01 && b[1] === 0x00 && isZeroPrefixFrom(b, 2, 8)) return deny('ipv6-discard')
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return deny('ipv6-documentation')
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return deny('ipv6-teredo')
  if ((b[0]! & 0xfe) === 0xfc) return deny('ipv6-unique-local')
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return deny('ipv6-link-local')
  if (b[0] === 0xff) return deny('ipv6-multicast')
  return ALLOWED
}

function isZeroPrefixFrom(b: number[], from: number, to: number): boolean {
  return b.slice(from, to).every((byte) => byte === 0)
}

/**
 * May Haven open an outbound connection to this address literal?
 *
 * Anything that is not a parseable IP literal is refused (`unparseable`) —
 * this function never guesses.
 */
export function isPublicUnicastAddress(address: string): AddressVerdict {
  const v4 = parseIpv4(address)
  if (v4 !== null) return classifyIpv4(v4)
  const v6 = parseIpv6(address)
  if (v6 !== null) return classifyIpv6(v6)
  return deny('unparseable')
}

/**
 * Hostnames that resolve to the local machine by convention rather than by
 * address, and so must be refused before any resolution happens.
 */
export function isLocallyBoundHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost') return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  // A single label ("router", "metadata") is a search-domain lookup, not a
  // public name — a merchant domain always has a dot.
  return !host.includes('.')
}
