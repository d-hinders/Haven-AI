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
 * ## What is a MODULE property and what is only a PATH property (#1959)
 *
 * Two proof paths means two chances for a rule to be true of one of them and
 * silently absent from the other. Both of the rules below are module
 * properties — enforced on the CLAIM, before a mechanism is chosen — and they
 * are stated here so a reader never has to diff the two call paths to find out
 * whether an asymmetry was a decision or an oversight:
 *
 * - **The hostname is a domain, never an IP literal.** Enforced by
 *   `isValidHostname` via `ipLiteralRange`, the same predicate `assertSafeUrl`
 *   uses, so the well-known and DNS-TXT paths cannot disagree. Before #1959
 *   this was a property of the well-known path only, because it was inherited
 *   from the SSRF guard, and the SSRF guard only sees paths that build a URL.
 * - **The verified string is the string inside the MAC.** Enforced by
 *   `isValidHostname`'s grammar and URL round-trip.
 *
 * What is NOT a module property, and must not be read as one: the CHANNEL
 * authentication. The well-known path gets host authentication from TLS; DNS
 * TXT does not, and cannot. That asymmetry is real, deliberate, and analysed
 * under "What we assume about the resolver" on `TxtResolver`.
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
import {
  ipLiteralRange,
  safeGetText,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '../../infra/http/ssrf-guard.js'

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
  | 'invalid_hostname'
  | 'invalid_token'
  | 'invalid_submission_id'
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
      /**
       * Per-method detail. **SERVER-SIDE ONLY — redact before returning this
       * to an untrusted caller.**
       *
       * `detail` propagates the SSRF guard's granular verdicts
       * (`ipv4-private`, `ipv6-unique-local`, `dns_failure`, …). Handed
       * verbatim to an anonymous submitter, that is a blind internal-DNS
       * oracle: they aim a redirect at a hostname they do not own and learn
       * whether Haven's resolver sees it and roughly what address class it
       * resolves into. No content leaks and no connection is made, so the
       * severity is limited — but it is free to close and expensive to
       * retrofit.
       *
       * FOR #1711's `GET /catalog/submit/:id` IMPLEMENTER: collapse every
       * `unreachable` / `proof_not_found` attempt to a single generic
       * "could not read the proof" for the public response, and keep these
       * values for logs and ops only. `proof_mismatch` is safe to surface —
       * it tells a genuine merchant their file content is wrong, which is
       * the one thing they need to know.
       */
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

/** One DNS label: 1–63 chars, alphanumeric, inner hyphens only. */
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The alphabet a `verify_token` may use: base64url, which also covers the hex
 * #1711 issues today. Bounded so the well-known path stays a sane length.
 */
const VERIFY_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * Is this a `verify_token` this module is willing to build a URL from?
 *
 * Same backstop reasoning as `isValidHostname`, and the reason it is enforced
 * here rather than left to #1711: the token is interpolated into the
 * well-known PATH, and an unvalidated one ESCAPES the `/.well-known/` prefix
 * entirely. Measured against the real URL parser, not reasoned about:
 *
 *   '../../../etc/passwd'  ->  path /etc/passwd.txt
 *   'abc\\..\\..\\x'       ->  path /x.txt
 *   'abc?x=1'              ->  path /.well-known/haven-verify-abc, query ?x=1
 *
 * The HOST is never changed by any of these, so this is not an SSRF pivot and
 * is not exploitable while #1711 generates 192 random bits of hex. But
 * "non-exploitable because an unmerged sibling slice is careful" is exactly
 * the dependency `isValidHostname` exists to refuse, and it would break the
 * same invariant: the URL actually fetched would differ from the URL
 * `ownershipInstructions` told the merchant to serve. Refused loudly rather
 * than escaped quietly — a token outside this alphabet is a bug upstream,
 * not a merchant mistake.
 */
export function isValidVerifyToken(token: string): boolean {
  return VERIFY_TOKEN.test(token)
}

/**
 * The alphabet a `submissionId` may use. UUIDs satisfy it; so do the other
 * opaque-id shapes a repository might reasonably produce.
 */
const SUBMISSION_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Is this a submission id this module is willing to put inside the MAC?
 *
 * The MAC's security argument is that its five fields are unambiguously
 * delimited by `\n`, and the module's own docstring leans on "hostname and
 * submissionId cannot contain `\n`" as load-bearing. Until this check existed
 * that was true of `hostname` and `verifyToken` — both strictly validated —
 * but merely ASSUMED of `submissionId`, and the assumption was about a slice
 * (#1711) that is not merged.
 *
 * No collision is constructible even without it: the field count is fixed at
 * five, and injecting a newline here ADDS a field, so producing an identical
 * message from a different (id, host, token) triple would require a newline
 * in `hostname` or `verifyToken`, which both now refuse. So this is symmetry
 * and an explicit trust boundary, not a live fix — recorded as a decision
 * rather than left as a silence, because a silence is how a decision quietly
 * becomes an omission.
 */
export function isValidSubmissionId(submissionId: string): boolean {
  return SUBMISSION_ID.test(submissionId)
}

function assertValidSubmissionId(submissionId: string): void {
  if (!isValidSubmissionId(submissionId)) {
    throw new Error('ownership claim carries a submission id outside the permitted alphabet')
  }
}

function assertValidVerifyToken(token: string): void {
  if (!isValidVerifyToken(token)) {
    // Deliberately does not echo the value.
    throw new Error('ownership claim carries a verify token outside the permitted alphabet')
  }
}

/**
 * Strict hostname grammar, applied as a BACKSTOP rather than as a convenience.
 *
 * The route that creates a submission (#1711) validates its input, but this
 * module must not depend on a sibling slice's validation being the only guard
 * — a security backstop with that coupling is not a backstop. The concrete
 * failure it closes: WHATWG `URL` SILENTLY STRIPS embedded tab/CR/LF rather
 * than erroring, so `"evil.com\n.attacker.net"` builds a URL whose host is
 * `evil.com.attacker.net`. No forgery follows (the fetch still has to reach
 * whatever that collapses to, which the attacker must genuinely control), but
 * the string fed to the MAC and persisted as "the verified domain" would not
 * be the string that was network-verified. That is a data-integrity and
 * log-injection defect the moment #1711/#1715/#1716 show it to a human — and
 * it would quietly falsify this module's own claim that there is no way to
 * implement the comparison sloppily. The comparison was always clean; its
 * INPUT was unvalidated.
 *
 * Rejecting every character outside `[a-z0-9.-]` also rules out C0/C1 control
 * characters, whitespace, and unicode by construction, so an IDN must arrive
 * already punycoded (`xn--…`, which satisfies the label grammar).
 *
 * ## The URL round-trip, which is the rule that actually holds the invariant
 *
 * The grammar alone is an enumeration of disguises, and enumerations lose.
 * WHATWG `URL` rewrites some hosts during canonicalization, and it does so in
 * more spellings than a label rule catches:
 *
 *   https://123.456/x               -> host 123.0.1.200   (abbreviated IPv4)
 *   https://0xa9.0xfe.0xa9.0xfe/x   -> host 169.254.169.254 (hex IPv4)
 *   https://0177.0.0.1/x            -> host 127.0.0.1     (octal IPv4)
 *
 * Each of those would make the string inside the MAC differ from the string
 * actually network-verified. Rather than patch a fourth spelling when someone
 * finds it, this function asserts the PROPERTY the module claims: the
 * normalized hostname must survive URL canonicalization byte-identically.
 * That covers every quirk of the parser, including ones not yet discovered.
 *
 * The grammar check is kept in front of it — it fails faster and yields a
 * better refusal reason — but the round-trip is what guarantees the invariant.
 *
 * Layering, stated precisely rather than optimistically: `assertSafeUrl` also
 * refuses all of these, as IP literals, so none could ever have reached
 * `ok: true`. That was the problem worth naming, not the reassurance — an
 * invariant held only by a downstream guard, while the function that appears
 * to own it does not, is the shape of a defect nobody finds until that guard
 * moves. With the round-trip in place this function holds it on its own, and
 * `assertSafeUrl` remains an independent second floor.
 *
 * ## The IP-literal rule, which the round-trip does NOT imply (#1959)
 *
 * The round-trip catches every host the URL parser REWRITES. An already-
 * canonical dotted-decimal IPv4 literal is not rewritten — `1.2.3.4` survives
 * it byte-identically — so the round-trip has nothing to say about it, and the
 * label grammar accepts it as four numeric labels. Only `assertSafeUrl`
 * refused it, and only on the path that builds a URL. `dnsTxtName` builds no
 * URL, so the DNS-TXT half of the proof had no equivalent refusal at all: a
 * bare address reached `resolveTxt` and, with a resolver that answered, could
 * reach `ok: true`. Verified before it was fixed, not assumed.
 *
 * That asymmetry is closed HERE rather than mirrored into the DNS path,
 * because a mechanism-specific fix would only hold until someone adds a third
 * mechanism. `ipLiteralRange` is the same predicate `assertSafeUrl` consults,
 * so the two verdicts cannot drift; the difference is that this one applies to
 * the CLAIM, before any mechanism is chosen. Refusing costs nothing real: a
 * bare address cannot make an ownership-of-a-DOMAIN claim in the first place,
 * which is the reason `assertSafeUrl` gives for its own refusal.
 */
export function isValidHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host.length === 0 || host.length > 253) return false
  const labels = host.split('.')
  // A merchant domain is never a single label; that is a search-domain lookup.
  if (labels.length < 2) return false
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return false
  // Claim-level, mechanism-independent — see "The IP-literal rule" above.
  // Placed before the round-trip because a canonical literal PASSES that check.
  if (ipLiteralRange(host) !== null) return false
  // The general rule — see "The URL round-trip" above.
  try {
    return new URL(`https://${host}/x`).hostname === host
  } catch {
    return false
  }
}

function assertValidHostname(hostname: string): void {
  if (!isValidHostname(hostname)) {
    // Deliberately does NOT echo the rejected value — it is attacker-supplied
    // and this message may reach a log.
    throw new Error('ownership claim carries a hostname that is not a valid DNS name')
  }
}

/**
 * The MAC over the claim. `\n`-delimited with a fixed context string so no two
 * different claims can produce the same input by shifting a delimiter into a
 * field — `hostname` and `submissionId` cannot contain `\n`, and the context
 * line domain-separates this MAC from any other use of the same secret.
 */
export function deriveOwnershipProof(claim: OwnershipClaim, secret: string): string {
  assertValidHostname(claim.hostname)
  assertValidVerifyToken(claim.verifyToken)
  assertValidSubmissionId(claim.submissionId)
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

/**
 * These three exports construct the fetch target and the DNS name, so each
 * validates its own inputs rather than trusting its caller. They are the
 * module's most attractive exports for a neighbouring slice to reuse —
 * #1711 wiring `wellKnownUrl` into a diagnostics response is the obvious
 * case — and reusing them off the validated path must not reintroduce the
 * newline or path-escape classes by the back door.
 */
export function wellKnownPath(claim: OwnershipClaim): string {
  assertValidVerifyToken(claim.verifyToken)
  return `/.well-known/haven-verify-${claim.verifyToken}.txt`
}

export function wellKnownUrl(claim: OwnershipClaim): string {
  assertValidHostname(claim.hostname)
  return `https://${normalizeHostname(claim.hostname)}${wellKnownPath(claim)}`
}

export function dnsTxtName(claim: OwnershipClaim): string {
  assertValidHostname(claim.hostname)
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
 *
 * ## What this path does NOT inherit from the SSRF guard (#1959)
 *
 * `resolveTxt` does not go through `assertSafeUrl`, and it never will —
 * there is no URL here to assert on. So every rule the guard enforces is
 * absent from this path unless the module enforces it itself:
 *
 * - **IP-literal refusal: enforced by the module.** `isValidHostname` refuses
 *   a bare address at claim level, so `dnsTxtName` cannot be handed one. This
 *   is the fix for #1959, and it is stated here because the previous reader of
 *   this section had to infer from the absence of a mention that the rule did
 *   not apply. It did not.
 * - **Address-range and connection-pinning checks: NOT applicable, by
 *   construction.** Those exist to stop a socket opening to attacker-chosen
 *   infrastructure. This path opens no socket to the claimed host: it issues a
 *   TXT lookup to the resolver the backend is already configured with, and
 *   reads a string back. That is why the IP-literal question here was a
 *   consistency and legibility question rather than an exploitable hole — the
 *   well-known path's refusal prevents an outbound HTTP request, and this
 *   one's does not prevent anything comparable.
 * - **Byte caps and deadlines: the resolver's, not ours.** A TXT answer is
 *   bounded by the DNS transport; `node:dns` timeouts apply.
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

  // Backstop, not convenience — see `isValidHostname`. Checked before expiry
  // so a malformed claim also never reaches an outbound request OR a DNS
  // lookup. One decision point, both proof paths (#1959): there is deliberately
  // no second IP-literal branch further down, because a rule enforced twice is
  // a rule that can be removed once and still look enforced.
  if (!isValidHostname(claim.hostname)) {
    // `reason` stays `invalid_hostname` — a new persisted enum member would
    // oblige #1711's status route to learn a value that means the same thing
    // to a submitter. The detail is what carries the distinction, and it
    // echoes no attacker-supplied text.
    // Same predicate, called a second time ONLY to enrich the message — not to
    // decide. The decision was made by `isValidHostname` above; this cannot
    // reach a different verdict, and it is not a second branch point. Spelled
    // out because the docstring above claims "one decision point, both proof
    // paths", and a reader skimming for that claim's counter-example would
    // stop here.
    const literal = ipLiteralRange(normalizeHostname(claim.hostname))
    return {
      ok: false,
      reason: 'invalid_hostname',
      detail:
        literal === null
          ? 'submission hostname is not a valid DNS name'
          : `submission hostname is an IP literal (${literal}), not a domain; ownership of a domain is the claim`,
      attempts,
    }
  }

  if (!isValidVerifyToken(claim.verifyToken)) {
    return {
      ok: false,
      reason: 'invalid_token',
      detail: 'submission verify token is outside the permitted alphabet',
      attempts,
    }
  }

  if (!isValidSubmissionId(claim.submissionId)) {
    return {
      ok: false,
      reason: 'invalid_submission_id',
      detail: 'submission id is outside the permitted alphabet',
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
