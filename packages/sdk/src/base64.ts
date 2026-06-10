/**
 * Runtime-agnostic base64 helpers — the single source of truth for the wire
 * encoding shared by the SDK and the edge signer (#325).
 *
 * Why this module exists: the SDK used `atob`/`btoa` (Web globals) while the
 * signer used `Buffer` (Node-only). Both worked because both currently run in
 * Node ≥ 16, but the duplication was a latent wire-incompatibility — and the
 * signer is headed for non-Node runtimes (browsers, Cloudflare Workers) where
 * `Buffer` does not exist (#314).
 *
 * Encoding contract:
 * - Output is ALWAYS standard base64 (`+`, `/`, padded). The x402 protocol's
 *   reference implementation validates headers against
 *   `/^[A-Za-z0-9+/]*={0,2}$/` — URL-safe output would be rejected.
 * - Decoding is tolerant: URL-safe input (`-`, `_`, unpadded) is normalized
 *   before decoding, since third-party merchants are not guaranteed to be as
 *   strict as the reference implementation.
 * - UTF-8 throughout. Naive `btoa(JSON.stringify(...))` throws on any
 *   non-Latin-1 character (e.g. a merchant description with an emoji or
 *   non-ASCII name); these helpers route through TextEncoder/TextDecoder on
 *   the Web path so multibyte characters round-trip identically on both
 *   runtimes.
 */

/** Normalize URL-safe alphabet and missing padding to standard base64. */
function normalizeBase64(value: string): string {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = standard.length % 4
  return remainder === 0 ? standard : standard + '='.repeat(4 - remainder)
}

/** Encode a UTF-8 string as standard base64. */
export function encodeBase64Utf8(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64')
  }
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode standard or URL-safe base64 to a UTF-8 string. */
export function decodeBase64Utf8(value: string): string {
  const normalized = normalizeBase64(value)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(normalized, 'base64').toString('utf8')
  }
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/** Encode a JSON-serializable value as a standard-base64 string. */
export function encodeBase64Json(value: unknown): string {
  return encodeBase64Utf8(JSON.stringify(value))
}

/**
 * Decode a base64 JSON payload.
 *
 * Pass a `label` to get a wrapped error message instead of the raw
 * JSON/base64 error — call sites parsing untrusted merchant headers use this
 * to produce actionable failures.
 */
export function decodeBase64Json<T>(value: string, label?: string): T {
  try {
    return JSON.parse(decodeBase64Utf8(value)) as T
  } catch (err) {
    if (label) throw new Error(`Failed to decode ${label}`)
    throw err
  }
}
