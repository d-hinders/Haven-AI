/**
 * Client compatibility — the ONE source for "which published client versions
 * does this Haven deployment still serve" (#3303, epic #3302).
 *
 * Every published Haven client names itself on each Haven API request with an
 * `X-Haven-Client: <package>/<version>` header. The backend reads that header
 * against the table below and either says nothing, attaches an update hint to
 * the response, or — only for a package whose `min_version` is SET and only at
 * a payment-initiating entry point (or, for the signer, at sign-context) —
 * refuses fail-closed with nothing written. The mechanism lives in
 * `packages/backend/src/middleware/client-compat.ts`; this file is the data and
 * the pure decision.
 *
 * **The table is hand-edited, by deliberate owner decision, and nothing else
 * writes it.** In particular the release bump does not: a release must never
 * raise a minimum as a side effect (#3305). A published minimum is a promise the
 * backend enforces, so the public release documents (#3304, `client-releases.ts`)
 * read these values from here rather than restating them.
 *
 * Owner decision (2026-09-25, on #3302): warn by default, refuse only when
 * flagged. A request with NO header, an unparseable one, a package not in the
 * table, or a `0.0.0-dev.*` dev-channel snapshot is never refused — every
 * install in the field before #3303 sends no header at all, and snapshot
 * versions sort below every real version.
 *
 * Pure, like the rest of `@haven_ai/core`: no I/O, no environment.
 */

/** The request header every published client sends. Case-insensitive on the wire. */
export const CLIENT_HEADER_NAME = 'X-Haven-Client'

/** The five packages published to npm — the only ones a deployment can hint or refuse. */
export const PUBLISHED_CLIENT_PACKAGES = [
  '@haven_ai/sdk',
  '@haven_ai/signer',
  '@haven_ai/mcp',
  '@haven_ai/connect',
  '@haven_ai/cli',
] as const

export type PublishedClientPackage = (typeof PUBLISHED_CLIENT_PACKAGES)[number]

export interface ClientCompatEntry {
  /**
   * Below this, every JSON-object response carries a `client_update` hint with
   * `required: false`. `null` = no hint.
   */
  recommended_version: string | null
  /**
   * Below this, the package's refusal points answer `client_outdated`. `null`
   * = never refused. Setting it is an owner decision, recorded where it is made.
   */
  min_version: string | null
}

/**
 * The compatibility table. Both columns start `null`: #3303 ships the
 * mechanism, and the first real value is an owner decision (the epic's
 * promotion checklist carries it).
 */
export const CLIENT_COMPAT: Readonly<Record<PublishedClientPackage, ClientCompatEntry>> = {
  '@haven_ai/sdk': { recommended_version: null, min_version: null },
  '@haven_ai/signer': { recommended_version: null, min_version: null },
  '@haven_ai/mcp': { recommended_version: null, min_version: null },
  '@haven_ai/connect': { recommended_version: null, min_version: null },
  '@haven_ai/cli': { recommended_version: null, min_version: null },
}

/** `<package>/<version>` — what a client puts in {@link CLIENT_HEADER_NAME}. */
export function formatClientHeader(pkg: string, version: string): string {
  return `${pkg}/${version}`
}

export interface ParsedClientHeader {
  package: string
  version: string
}

// A strict semver 2.0 version: core triple, optional prerelease, optional build.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Parse `@scope/name/1.2.3-alpha.0`. The version is everything after the LAST
 * slash, so a scoped package name keeps its own slash. Returns null for
 * anything that is not exactly a package name plus a strict semver version —
 * an unparseable header is treated as no header, never as a refusable one.
 */
export function parseClientHeader(raw: string | string[] | undefined): ParsedClientHeader | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return null
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  const pkg = trimmed.slice(0, slash)
  const version = trimmed.slice(slash + 1)
  if (!SEMVER_RE.test(version)) return null
  return { package: pkg, version }
}

/** The dev-channel snapshot versions `release-bump.mjs --snapshot` publishes. */
export function isSnapshotVersion(version: string): boolean {
  return version.startsWith('0.0.0-dev.')
}

/**
 * Semver 2.0 precedence: negative when `a < b`, 0 when equal, positive when
 * `a > b`. Build metadata is ignored. Both inputs must be valid (see
 * {@link parseClientHeader}); an invalid one throws, because a compat table
 * holding a malformed version is a bug to surface, not a value to guess at.
 */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a)
  const pb = SEMVER_RE.exec(b)
  if (!pa || !pb) throw new Error(`compareVersions: not a semver version: ${!pa ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff
  }
  const preA = pa[4]
  const preB = pb[4]
  if (preA === undefined && preB === undefined) return 0
  // A version without a prerelease outranks one with: 1.0.0 > 1.0.0-alpha.
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  const idsA = preA.split('.')
  const idsB = preB.split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i]
    const y = idsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (xNum !== yNum) {
      // Numeric identifiers sort below alphanumeric ones.
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function isPublishedClientPackage(pkg: string): pkg is PublishedClientPackage {
  return (PUBLISHED_CLIENT_PACKAGES as readonly string[]).includes(pkg)
}

/**
 * What the deployment thinks of one request's client.
 *
 * - `unidentified` — no header, or one that does not parse. Never hinted, never refused.
 * - `exempt` — a parsed header this table does not govern: a package outside the
 *   five published ones (the hosted `mcp-server` is Haven-deployed and names
 *   nothing here), or a dev-channel snapshot.
 * - `current` — at or above every configured threshold.
 * - `behind` — below `recommended_version`, at or above any `min_version`: hint only.
 * - `below_min` — below a SET `min_version`: refusable at the package's refusal points.
 */
export type ClientCompatVerdict =
  | { kind: 'unidentified' }
  | { kind: 'exempt'; package: string; version: string; reason: 'unlisted_package' | 'snapshot' }
  | { kind: 'current'; package: PublishedClientPackage; version: string }
  | {
      kind: 'behind' | 'below_min'
      package: PublishedClientPackage
      version: string
      recommended_version: string | null
      min_version: string | null
    }

export function evaluateClient(
  header: string | string[] | undefined,
  table: Readonly<Record<PublishedClientPackage, ClientCompatEntry>> = CLIENT_COMPAT,
): ClientCompatVerdict {
  const parsed = parseClientHeader(header)
  if (!parsed) return { kind: 'unidentified' }
  const { package: pkg, version } = parsed
  if (!isPublishedClientPackage(pkg)) {
    return { kind: 'exempt', package: pkg, version, reason: 'unlisted_package' }
  }
  if (isSnapshotVersion(version)) return { kind: 'exempt', package: pkg, version, reason: 'snapshot' }
  const entry = table[pkg]
  const detail = {
    package: pkg,
    version,
    recommended_version: entry.recommended_version,
    min_version: entry.min_version,
  }
  if (entry.min_version !== null && compareVersions(version, entry.min_version) < 0) {
    return { kind: 'below_min', ...detail }
  }
  if (entry.recommended_version !== null && compareVersions(version, entry.recommended_version) < 0) {
    return { kind: 'behind', ...detail }
  }
  return { kind: 'current', package: pkg, version }
}
