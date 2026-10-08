/**
 * #3778 — the `delivery_reference` guard, shared by every surface that accepts
 * one.
 *
 * A delivery reference is a NON-SECRET pointer to a delivered good ("Bik Bok
 * 5 SEK, order 6ac7…") that an agent reports with its x402 outcome so the
 * owner's receipt and dashboard show that a deliverable EXISTS and where to
 * recover it. It must never carry the deliverable itself — a redemption code,
 * PIN, session token or key. The relay of the actual secret stays the agent's
 * job (the haven-pay skill's rule); this guard is the backstop that refuses
 * the obvious credential shapes from being persisted into Haven's evidence
 * row, where the owner (and any receipt export) would read them.
 *
 * Deliberately conservative, in the refuse-obvious-shapes direction only:
 *
 *   - False NEGATIVES are accepted. A redemption code we cannot recognize is
 *     not stopped by the guard; the skill text's relay rule is the primary
 *     control, and this check exists to catch the shapes no honest delivery
 *     reference ever takes (JWTs, API keys, raw token material), not to be an
 *     entropy oracle. We do not pretend to detect randomness.
 *   - False POSITIVES are the cost to avoid. Merchant order ids, invoice
 *     numbers and product names are exactly what this field is FOR, so the
 *     shapes below all require dense, whitespace-free token material before
 *     they fire — "order 6ac7", "ORD-2026-10-08-001" and "INV 88123" pass.
 */

/** The wire bound (zod max / column width) every validator must mirror. */
export const DELIVERY_REFERENCE_MAX_LENGTH = 512

const JWT_SEGMENT = '[A-Za-z0-9_-]+'
const JWT_RE = new RegExp(`^${JWT_SEGMENT}\\.${JWT_SEGMENT}\\.${JWT_SEGMENT}$`)
const HEX_TOKEN_RE = /^[0-9a-fA-F]{32,}$/
/** A whitespace-free run over base64/base64url charset (the classic API-key shape). */
const BASE64ISH_TOKEN_RE = /^[A-Za-z0-9+/=_-]{24,}$/
/** A hyphen-grouped uppercase code, e.g. GRBQ-KX4M-9P2T — every group 4-6 chars. */
const GROUPED_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/
/** A single whitespace-free token of mixed-case dense token material. */
const CODE_TOKEN_RE = /^[A-Za-z0-9-]{16,}$/

const SECRET_PREFIXES = [
  'sk_',
  'pk_',
  'ghp_',
  'github_pat_',
  'AKIA',
  'xoxb-',
  'xoxp-',
  'Bearer ',
] as const

/**
 * True when the value is shaped like a credential rather than a reference.
 * Exported for the refusal message's own wording and for tests.
 */
export function deliveryReferenceLooksLikeSecret(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (SECRET_PREFIXES.some((p) => trimmed.startsWith(p))) return true
  if (JWT_RE.test(trimmed)) return true
  if (HEX_TOKEN_RE.test(trimmed)) return true
  // Dense token material: no whitespace anywhere, both letters and digits,
  // long enough that no honest order/product reference needs the shape.
  if (BASE64ISH_TOKEN_RE.test(trimmed)) {
    const digits = (trimmed.match(/[0-9]/g) ?? []).length
    const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length
    if (digits >= 2 && letters >= 2) return true
  }
  // Mixed-case code token: 16+ chars, no whitespace, >= 2 digits. Mixed case
  // plus digits in one whitespace-free run is token material, not prose.
  if (CODE_TOKEN_RE.test(trimmed) && /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    if ((trimmed.match(/[0-9]/g) ?? []).length >= 2) return true
  }
  // Hyphen-grouped uppercase code (gift-card shape): >= 3 uniform 4-6 char
  // groups, at least two of which contain a digit. "ORD-2026-10-08-001" does
  // not fire — its 3-char group fails the uniformity test, and ids with
  // variable-length segments are not uniform by design.
  if (GROUPED_CODE_RE.test(trimmed)) {
    const groups = trimmed.split('-')
    if (groups.length >= 3 && groups.every((g) => g.length >= 4 && g.length <= 6)) {
      const digitGroups = groups.filter((g) => /[0-9]/.test(g)).length
      if (digitGroups >= 2) return true
    }
  }
  return false
}

/**
 * The shared semantic validator: null when acceptable, else a refusal reason.
 * Callers turn the reason into their own error shape (zod refine, 400 body,
 * HostedToolError). Trimming is the caller's choice on write; this validates
 * the value as given.
 */
export function deliveryReferenceError(value: string): string | null {
  if (value.length > DELIVERY_REFERENCE_MAX_LENGTH) {
    return `delivery_reference must be at most ${DELIVERY_REFERENCE_MAX_LENGTH} characters`
  }
  if (deliveryReferenceLooksLikeSecret(value)) {
    return (
      'delivery_reference refused: the value is shaped like a credential (a code, token or key), ' +
      'not like a delivery reference. Report the non-secret pointer instead (merchant, product, ' +
      'value, order id) and relay the secret itself to the owner directly.'
    )
  }
  return null
}
