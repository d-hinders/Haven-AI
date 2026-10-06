/**
 * Ops console masking (#3509, epic #3507).
 *
 * Every ops list and detail response masks personal data by default; the
 * unmasked value is only ever returned by `POST /ops/reveal`, one field at a
 * time, with an audit row. Masking happens server-side so an unmasked value
 * never reaches the browser unless an operator asked for it.
 */

/** `daniel@gmail.com` → `da•••@gmail.com`. Short local parts keep one character. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '•••'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const keep = local.length > 2 ? 2 : 1
  return `${local.slice(0, keep)}•••@${domain}`
}

/** `0x12ab…9f3c` for an address or hash; anything shorter than that collapses to `•••`. */
export function maskHex(value: string): string {
  if (value.length < 12) return '•••'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** A person's name: first character only (`Daniel` → `D•••`). */
export function maskName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return ''
  return `${Array.from(trimmed)[0]}•••`
}

/**
 * Free-text feedback (#3602): the masked form leaks no content at all —
 * no prefix, no excerpt, only the length. A customer's feedback message is
 * arbitrary text (a bug report may quote an error string or a credential
 * shape), so unlike the email/name maskers there is nothing safe to keep.
 * The unmasked value leaves only through `POST /ops/reveal`, audited.
 */
export function maskFreeText(text: string): string {
  const length = Array.from(text.trim()).length
  return length === 0 ? '(empty)' : `${length} characters`
}

/**
 * The masked form of a search term, for the audit log: the query an operator
 * typed may be a customer's email, and an audit row must not become a second
 * copy of it.
 */
export function maskSearchTerm(term: string): string {
  const trimmed = term.trim()
  if (trimmed.includes('@')) return maskEmail(trimmed)
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return maskHex(trimmed)
  if (trimmed.length <= 4) return '•••'
  return `${trimmed.slice(0, 2)}•••`
}
