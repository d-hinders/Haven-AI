/**
 * Credential row labels (#1679, copy-guidelines § "Name credentials
 * 'passkey', never a platform brand").
 *
 * Two shapes, one source (#4474):
 *
 * - `passkeyRowParts` — the SPLIT form a two-line row renders: the kind on
 *   line 1 and "Added {date}" on line 2. The kind is "Passkey" when the
 *   account has exactly one passkey, and "Passkey 1", "Passkey 2", … in
 *   enrollment order when it has two or more — an ordinal is only worth the
 *   words when there is more than one to tell apart. No stored date → no
 *   second line, and the ordinal still shows.
 * - `passkeyRowLabel` — the ONE-LINE form, derived from the split form, for
 *   surfaces with no second line to put a date on (the wallet popover's
 *   "signing with" phrase, Settings' signer list).
 *
 * Never a platform brand, and never positional in the old sense (a platform
 * name for index 0, "Backup N" for the rest): that misnamed the surviving
 * backup as the primary after a recovery removed the original key.
 */
import { formatLongDate } from '@/lib/format'

export type PasskeyRowParts = {
  /** Line 1 — the kind: "Passkey", or "Passkey N" when the account has two or more. */
  kind: string
  /** Line 2 — "Added {date}", or `null` when no enrollment date is stored. */
  added: string | null
}

/**
 * The split form. `index` is the passkey's position in enrollment order and
 * `count` is how many passkeys the account has — the ordinal appears only
 * when `count > 1`.
 */
export function passkeyRowParts(
  createdAt: string | null | undefined,
  index: number,
  count: number,
): PasskeyRowParts {
  const kind = count > 1 ? `Passkey ${index + 1}` : 'Passkey'
  const date = createdAt ? new Date(createdAt) : null
  if (!date || Number.isNaN(date.getTime())) return { kind, added: null }
  // The shared long-date rule (#4166) — the row used to render en-US
  // ("October 16, 2026") while the account page's created date rendered
  // en-GB ("16 October 2026") one tab away. `passkeyLabels` is shared with
  // `WalletButton` and Settings' `SignersSection`, so those change with it.
  return { kind, added: `Added ${formatLongDate(date)}` }
}

/**
 * The one-line form: "Passkey · added {date}", or the ordinal when no date is
 * stored. Derived from `passkeyRowParts` so the two cannot drift.
 *
 * `count` defaults to 1 — the one-line callers (the wallet popover, Settings'
 * signer list) name a credential without knowing how many the account holds.
 * With no stored date the one-line form keeps the ORDINAL ("Passkey 1") even
 * for a lone credential: it has no second line to carry the date, and Settings'
 * list mixes credentials from several accounts, so two undated rows must stay
 * distinguishable. The split form puts the ordinal in the kind instead.
 */
export function passkeyRowLabel(
  createdAt: string | null | undefined,
  index: number,
  count = 1,
): string {
  const { kind, added } = passkeyRowParts(createdAt, index, count)
  if (!added) return count > 1 ? kind : `Passkey ${index + 1}`
  // "Added 3 March 2026" → "Passkey · added 3 March 2026": the one-line form
  // lowercases the verb so the phrase reads as one clause.
  return `${kind} · ${added.charAt(0).toLowerCase()}${added.slice(1)}`
}
