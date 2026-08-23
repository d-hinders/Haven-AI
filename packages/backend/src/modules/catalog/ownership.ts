/**
 * Domain-ownership proof for catalogue ingestion (epic #1717, #1712).
 *
 * ## What this is for
 *
 * A `POST /catalog/submit` row (#1711) is a CLAIM by an anonymous party that
 * they control a domain. This module is what turns that claim into evidence.
 * Downstream, `verified_payable` entries are handed to agents that pay
 * merchants, so the failure mode here is not a bug — it is a directory that
 * vouches for domains nobody proved they control. It is built as a security
 * control, and every property below exists because dropping it would let
 * someone list a domain they do not own.
 *
 * ## The proof
 *
 * The submitter publishes ONE line, in either of two places:
 *
 *   well-known  GET https://<hostname>/.well-known/haven-verify-<token>.txt
 *   DNS TXT     TXT _haven-verify.<hostname>
 *
 * whose content is exactly:
 *
 *   haven-domain-verification=v1.<submissionId>.<proof>
 *
 * where
 *
 *   proof = base64url(HMAC-SHA256(K, "haven-domain-ownership\nv1\n"
 *                                    + submissionId + "\n"
 *                                    + hostname + "\n"
 *                                    + verifyToken))
 *
 * and `K` is a server-held secret (`CATALOG_OWNERSHIP_SECRET`) that never
 * leaves Haven. Four properties follow, and each maps to an attack:
 *
 * - **Unpredictable.** Computing `proof` needs `K`. An attacker cannot
 *   pre-place a passing file on a domain, and cannot compute one for a
 *   victim's domain. `verifyToken` is independently 192 random bits (#1711),
 *   so even the FILENAME cannot be guessed.
 * - **Domain-bound.** `hostname` is inside the MAC. A proof harvested from a
 *   domain the attacker does own does not verify against any other hostname,
 *   because verification recomputes the expectation from the CLAIMED row's
 *   hostname. This is why the hostname is not echoed in the payload: there is
 *   nothing to edit, and no way to implement the comparison sloppily.
 * - **Claim-bound.** `submissionId` is inside the MAC, so a proof cannot be
 *   replayed onto a different submission row — including a later row for the
 *   same host, which carries a different id and a different token.
 * - **Expiring.** A proof is only accepted inside `TOKEN_TTL_MS` of issue.
 *   `isTokenExpired` is checked BEFORE any outbound request, so an expired
 *   claim cannot even be used to make Haven emit traffic.
 *
 * ## Single-use vs idempotent — the choice, and why
 *
 * Verification here is **idempotent within the token lifetime**, not
 * single-use. Verification is retried by an async leader-locked worker
 * (#1713), so single-use would let one transient network blip permanently
 * burn a merchant's proof and strand the submission. Idempotency is safe
 * because it is not what bounds the proof:
 *
 *   - forgery is bounded by the MAC (an attacker replaying a proof can only
 *     re-prove something that was already true, for the one claim it names);
 *   - the window is bounded by the TTL;
 *   - the STATE TRANSITION is once-only, and that guard belongs to the
 *     repository: the transition must be written `... WHERE status =
 *     'submitted'`, so once a row leaves `submitted` — verified, failed, or
 *     operator-delisted — the token stops being able to move it. That guard
 *     lives in #1711's repository (see the dependency note below) and is the
 *     reason revocation works: delisting a row revokes its proof by making
 *     the transition unreachable, without needing a revocation list.
 *
 * ## What is NOT here, and why
 *
 * The DB and route half of #1712 — the migration adding the verification
 * columns, the `submitted → ownership_verified` transition, and
 * `GET /catalog/submit/:id` — depends on `catalog_submissions`, which is
 * #1711 (PR #1837, unmerged and CONFLICTING at the time of writing). Rather
 * than absorb another session's queue, this module is deliberately DB-free
 * and route-free: it takes a claim as a value and returns a verdict as a
 * value. Wiring it is a one-function call from whoever lands #1711.
 *
 * Note what `verifyDomainOwnership` returns on success: `verifiedAt`, not
 * just `true`. A proof that held once does not hold forever, and #1714 owns
 * re-verification cadence — it can only do that if the moment of proof is
 * recorded, so this module makes recording it unavoidable rather than
 * optional.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { safeGetText, type SafeFetchOptions, type SafeFetchResult } from '../../infra/http/ssrf-guard.js'

/** Proof format version. Bump only with a migration plan for live claims. */
export const OWNERSHIP_PROOF_VERSION = 'v1'
/** Payload prefix, so a merchant can grep their own file. */
export const OWNERSHIP_PAYLOAD_PREFIX = 'haven-domain-verification='
/** DNS label the TXT record is published under. */
export const OWNERSHIP_DNS_LABEL = '_haven-verify'
/** How long an issued token may be used to prove ownership. */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The claim being proven. Every field is inside the MAC except `tokenIssuedAt`. */
export interface OwnershipClaim {
  submissionId: string
  hostname: string
  verifyToken: string
  /** When `verifyToken` was issued — `catalog_submissions.created_at` today. */
  tokenIssuedAt: Date
}

export type OwnershipMethod = 'well-known' | 'dns-txt'

/** Stable, persistable failure reasons. */
export type OwnershipFailureReason =
  | 'not_configured'
  | 'token_expired'
  | 'proof_not_found'
  | 'proof_mismatch'
  | 'unreachable'

export type OwnershipResult =
  | { ok: true; method: OwnershipMethod; verifiedAt: Date }
  | {
      ok: false
      reason: OwnershipFailureReason
      detail: string
      /** Per-method detail, for the status endpoint's "why not yet" line. */
      attempts: { method: OwnershipMethod; reason: OwnershipFailureReason; detail: string }[]
    }

/** When this claim's token stops being usable. */
export function tokenExpiresAt(claim: OwnershipClaim, ttlMs: number = TOKEN_TTL_MS): Date {
  return new Date(claim.tokenIssuedAt.getTime() + ttlMs)
}

export function isTokenExpired(claim: OwnershipClaim, now: Date, ttlMs: number = TOKEN_TTL_MS): boolean {
  return now.getTime() >= tokenExpiresAt(claim, ttlMs).getTime()
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * The MAC over the claim. `\n`-delimited with a fixed context string so no two
 * different claims can produce the same input by shifting a delimiter into a
 * field — `hostname` and `submissionId` cannot contain `\n`, and the context
 * line domain-separates this MAC from any other use of the same secret.
 */
export function deriveOwnershipProof(claim: OwnershipClaim, secret: string): string {
  const message = [
    'haven-domain-ownership',
    OWNERSHIP_PROOF_VERSION,
    claim.submissionId,
    normalizeHostname(claim.hostname),
    claim.verifyToken,
  ].join('\n')
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url')
}

/** The exact single line the submitter must publish. */
export function expectedProofPayload(claim: OwnershipClaim, secret: string): string {
  return `${OWNERSHIP_PAYLOAD_PREFIX}${OWNERSHIP_PROOF_VERSION}.${claim.submissionId}.${deriveOwnershipProof(claim, secret)}`
}

export function wellKnownPath(claim: OwnershipClaim): string {
  return `/.well-known/haven-verify-${claim.verifyToken}.txt`
}

export function wellKnownUrl(claim: OwnershipClaim): string {
  return `https://${normalizeHostname(claim.hostname)}${wellKnownPath(claim)}`
}

export function dnsTxtName(claim: OwnershipClaim): string {
  return `${OWNERSHIP_DNS_LABEL}.${normalizeHostname(claim.hostname)}`
}

/**
 * Everything `GET /catalog/submit/:id` needs to tell a submitter what to do.
 * Contains the proof payload, which is fine — it is only useful to whoever
 * already holds the submission id, and publishing it IS the intended action.
 */
export function ownershipInstructions(
  claim: OwnershipClaim,
  secret: string,
): {
  expires_at: string
  well_known: { url: string; content: string; instruction: string }
  dns_txt: { name: string; value: string; instruction: string }
} {
  const payload = expectedProofPayload(claim, secret)
  return {
    expires_at: tokenExpiresAt(claim).toISOString(),
    well_known: {
      url: wellKnownUrl(claim),
      content: payload,
      instruction: `Serve this exact line over HTTPS at ${wellKnownPath(claim)}`,
    },
    dns_txt: {
      name: dnsTxtName(claim),
      value: payload,
      instruction: `Publish this exact value as a TXT record at ${dnsTxtName(claim)}`,
    },
  }
}

/**
 * Constant-time comparison that does not leak length either. Both sides are
 * hashed to a fixed 32 bytes first, so `timingSafeEqual` always gets equal
 * lengths and never throws on a short candidate.
 */
function proofMatches(expected: string, candidate: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(candidate, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * Pick the proof line out of a served document. A merchant's file may carry a
 * trailing newline, CRLF, or a stray blank line; nothing else is tolerated,
 * and no line is accepted unless it matches the expectation exactly.
 */
function documentContainsProof(document: string, expected: string): boolean {
  return document
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .some((line) => proofMatches(expected, line))
}

/**
 * DNS TXT lookup seam.
 *
 * ## What we assume about the resolver
 *
 * We use the resolver the backend host is configured with, over plain DNS.
 * That means: no TLS, no DNSSEC validation, answers may be cached anywhere on
 * the path, and anyone who controls resolution can forge a response. We do
 * NOT assume the resolver is trustworthy, and the design does not need it to
 * be — which is the reason DNS TXT is acceptable as a fallback at all:
 *
 * - a resolver-level attacker cannot MANUFACTURE a passing record, because
 *   the payload requires `K`;
 * - they can SUPPRESS a real record, which fails the verification closed —
 *   denial, never a false positive;
 * - they can REPLAY a genuine record they observed, but it is bound to that
 *   hostname and that submission id, so replaying it only re-proves something
 *   that was already true for the claim it names.
 *
 * The residual is that DNS TXT has weaker channel authentication than the
 * well-known file, which gets host authentication from TLS. That is why
 * well-known is attempted FIRST and DNS TXT is documented as the fallback for
 * merchants who cannot serve a file.
 */
export type TxtResolver = (name: string) => Promise<string[][]>

const systemTxtResolver: TxtResolver = async (name) => {
  const { resolveTxt } = await import('node:dns/promises')
  return await resolveTxt(name)
}

export interface OwnershipDeps {
  /** Guarded reader; defaults to the shared SSRF guard. Never a bare fetch. */
  fetchText?: (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>
  resolveTxt?: TxtResolver
  now?: Date
  ttlMs?: number
}

/**
 * Verify that whoever submitted this claim controls the domain.
 *
 * Order is deliberate: configuration, then expiry, then well-known, then DNS.
 * The first two are local checks, so an unconfigured deployment and an expired
 * claim both refuse WITHOUT Haven emitting any outbound request at all.
 */
export async function verifyDomainOwnership(
  claim: OwnershipClaim,
  secret: string,
  deps: OwnershipDeps = {},
): Promise<OwnershipResult> {
  const now = deps.now ?? new Date()
  const fetchText = deps.fetchText ?? safeGetText
  const resolveTxt = deps.resolveTxt ?? systemTxtResolver
  const attempts: { method: OwnershipMethod; reason: OwnershipFailureReason; detail: string }[] = []

  // Fail closed on a missing secret. Without `K` there is no unforgeable
  // proof, so the only safe answer is that nothing can be verified — never a
  // fallback to a guessable derivation.
  if (secret === '') {
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'CATALOG_OWNERSHIP_SECRET is not set; domain ownership cannot be proven',
      attempts,
    }
  }

  if (isTokenExpired(claim, now, deps.ttlMs)) {
    return {
      ok: false,
      reason: 'token_expired',
      detail: `verify token expired at ${tokenExpiresAt(claim, deps.ttlMs).toISOString()}`,
      attempts,
    }
  }

  const expected = expectedProofPayload(claim, secret)

  // --- Method 1: the well-known file, read through the SSRF guard. ---
  const response = await fetchText(wellKnownUrl(claim))
  if (response.ok) {
    if (documentContainsProof(response.body, expected)) {
      return { ok: true, method: 'well-known', verifiedAt: now }
    }
    attempts.push({
      method: 'well-known',
      reason: 'proof_mismatch',
      detail: 'file served but its content is not this claim\'s proof',
    })
  } else {
    attempts.push({
      method: 'well-known',
      reason: 'unreachable',
      detail: `${response.reason}: ${response.detail}`,
    })
  }

  // --- Method 2: the DNS TXT fallback. ---
  try {
    const records = await resolveTxt(dnsTxtName(claim))
    // A TXT answer is an array of records, each an array of strings that the
    // resolver split at 255 bytes; joining is the correct reassembly.
    const values = records.map((chunks) => chunks.join(''))
    if (values.some((value) => proofMatches(expected, value.trim()))) {
      return { ok: true, method: 'dns-txt', verifiedAt: now }
    }
    attempts.push({
      method: 'dns-txt',
      reason: values.length === 0 ? 'proof_not_found' : 'proof_mismatch',
      detail:
        values.length === 0
          ? `no TXT records at ${dnsTxtName(claim)}`
          : `${values.length} TXT record(s) present, none is this claim's proof`,
    })
  } catch (err) {
    attempts.push({
      method: 'dns-txt',
      reason: 'proof_not_found',
      detail: `TXT lookup failed: ${(err as Error).message}`,
    })
  }

  const mismatched = attempts.some((a) => a.reason === 'proof_mismatch')
  return {
    ok: false,
    reason: mismatched ? 'proof_mismatch' : 'proof_not_found',
    detail: attempts.map((a) => `${a.method}: ${a.detail}`).join('; '),
    attempts,
  }
}
