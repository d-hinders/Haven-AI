import { english, privateKeyToAddress } from 'viem/accounts'

/**
 * The backend half of the feedback secret check (#3597).
 *
 * `POST /feedback` is the backstop, not the control — the CLI's own check
 * (`packages/cli/src/secret-check.ts`, a dependency-free copy so
 * `@haven_ai/cli` need not import `@haven_ai/connect`) refuses BEFORE any
 * request carrying the text is sent. This module re-runs layers 1 (labelled
 * secrets) and 4 (recovery phrases) against the raw body, and the route
 * re-runs layer 3 (key-backed-address derivation) against the database
 * itself rather than the caller's own `GET /agents` / signers reads — see
 * `routes/feedback.ts`.
 *
 * Side-effect-free on purpose: nothing here touches the database or the
 * filesystem, so it can run before the request is parsed into anything that
 * would need rolling back. It imports `viem/accounts` (for address
 * derivation and the English BIP-39 wordlist), which is exactly why it lives
 * under `modules/feedback/` rather than `domain/` — `domain-stays-pure`
 * (#998) forbids that import inside `domain/`. The rule is waivable (an
 * inline `dep-lint-exempt` comment can clear it, like several other rules
 * in `.dependency-cruiser.cjs`), but no such waiver exists in `domain/`
 * today, so this file lives here carrying none rather than there carrying
 * one.
 */

/**
 * Layer 1 — prefixed and labelled secrets. A superset of
 * `redactVendorSecrets` (`domain/redact-vendor-secrets.ts`): stored feedback
 * text can never trip the ops grant script's vendor-secret refusal, because
 * every pattern that refusal looks for is refused here FIRST, before
 * anything is written.
 *
 * Returns a short machine-readable reason, or `null` when nothing matched.
 * No false positives — every pattern here is a label or a prefix, never a
 * bare shape (a bare 64-hex token is layer 3, not this layer).
 */
export function detectLabelledSecret(text: string): string | null {
  if (/sk_agent_[A-Za-z0-9]/.test(text)) return 'agent_api_key'
  if (/hv_setup_[A-Za-z0-9]/.test(text)) return 'setup_token'
  // A session JWT: three dot-separated base64url parts, each non-empty.
  // `\beyJ` (not the looser `\bey`), which is the base64url encoding of `{"`
  // — every real JWT header starts there, and the tighter anchor stops
  // ordinary words like "eyebrow" or "eyelet" from matching their own tail.
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text)) return 'session_jwt'
  // key= / api_key= / api-key= / apikey= / token= / secret=, `\b`-bounded —
  // the same boundary `redact-vendor-secrets.ts` uses.
  if (/\b(api[_-]?key|key|token|secret)=[^&\s"'\\)]+/i.test(text)) return 'labelled_parameter'
  // user:pass@ URL credentials.
  if (/https?:\/\/[^\s/@]+:[^\s@]+@/i.test(text)) return 'url_credentials'
  // RPC-path keys: /rpc/<16+ chars> or /v2/<16+ chars>.
  if (/\/(?:rpc|v2)\/[A-Za-z0-9_-]{16,}/.test(text)) return 'rpc_path_key'
  return null
}

/**
 * Layer 3's token extraction: exactly 64 hex characters, optional `0x`,
 * bounded by a non-hex character on both sides so a longer calldata run is
 * never windowed into candidates (a 128-hex run yields zero candidates, not
 * two).
 */
export function findHexTokenCandidates(text: string): string[] {
  const matches = text.matchAll(/(?<![0-9a-fA-F])(0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)
  return [...matches].map((m) => m[2])
}

/**
 * Treat a 64-hex token as a secp256k1 private key and derive its Ethereum
 * address, or `null` when it is not a valid key (a zero key or a key ≥ the
 * curve order `n` — `viem/accounts` rejects both, the same thing
 * `createECDH.setPrivateKey` throws on in the CLI's copy of this check). A
 * transaction hash, a delegation hash and a schema hash all pass through
 * this as `null` far more often than not, which is the whole reason layer 3
 * exists: shape alone cannot tell a key from a hash, so this asks what the
 * token would DO.
 *
 * **Deliberately the address-only helper, never the account-constructing
 * one.** The non-custody invariant
 * (`src/__tests__/non-custody.invariants.test.ts`'s "creates no viem
 * key-based signers server-side", Red Line #1/#2) bans the three
 * `viem/accounts` helpers that build a SIGNING-CAPABLE object from key
 * material, from every backend production file, absolutely — by scanning
 * for their names as plain text, so even naming one in a comment trips it.
 * The rule is structural (no such object may exist server-side) rather than
 * behavioural (trusting this call site to never invoke a `sign*` method).
 * `viem/accounts`'s address-only export returns a string and nothing else:
 * there is no signer here to not-sign.
 */
export function deriveAddressFromHexToken(token: string): `0x${string}` | null {
  try {
    return privateKeyToAddress(`0x${token}`)
  } catch {
    return null
  }
}

const BIP39_WORDS = new Set(english.map((w) => w.toLowerCase()))
/** The shortest mnemonic BIP-39 mints. Any run at least this long contains one. */
const MIN_RECOVERY_PHRASE_WORDS = 12

/**
 * Layer 4 — a run of 12, 15, 18, 21 or 24 CONSECUTIVE BIP-39 English words.
 * Tokenised on whitespace, with leading/trailing punctuation stripped per
 * token so "word1, word2." still counts as two words. Checking for a run of
 * at least 12 is sufficient: a run of 13, 20 or 200 words CONTAINS a 12-word
 * run, which is itself "12 consecutive BIP-39 words" — there is no case where
 * a longer run should pass that a 12-word one would refuse.
 */
export function containsRecoveryPhrase(text: string): boolean {
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').toLowerCase())
  let run = 0
  for (const token of tokens) {
    if (token && BIP39_WORDS.has(token)) {
      run += 1
      if (run >= MIN_RECOVERY_PHRASE_WORDS) return true
    } else {
      run = 0
    }
  }
  return false
}
