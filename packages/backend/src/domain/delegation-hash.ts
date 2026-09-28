/**
 * The delegation-hash wire shape shared by the owner revoke routes (#3343).
 *
 * Both submit routes must validate the hashes they are handed exactly as
 * their prepares do; one copy of the regex and of the list guard keeps the
 * submit-side checks from drifting (a typeof ladder per route file is also
 * what the request-schemas ratchet counts, so the guard lives here, outside
 * `routes/`).
 */
export const DELEGATION_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export function isDelegationHashList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((h) => typeof h === 'string' && DELEGATION_HASH_RE.test(h))
  )
}
