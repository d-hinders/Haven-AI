/**
 * Credential row labels (#1679, copy-guidelines § "Name credentials
 * 'passkey', never a platform brand").
 *
 * "Passkey · added {date}" — the kind plus enrollment time, never a platform
 * brand and never positional: the positional variant (a platform name
 * for index 0, "Backup N" for the rest) misnamed the surviving backup as the
 * primary after a recovery removed the original key. No stored date → ordinal
 * "Passkey N" in enrollment order.
 */
import { formatLongDate } from '@/lib/format'

export function passkeyRowLabel(createdAt: string | null | undefined, index: number): string {
  const date = createdAt ? new Date(createdAt) : null
  if (!date || Number.isNaN(date.getTime())) return `Passkey ${index + 1}`
  // The shared long-date rule (#4166) — the row used to render en-US
  // ("October 16, 2026") while the account page's created date rendered
  // en-GB ("16 October 2026") one tab away. `passkeyLabels` is shared with
  // `WalletButton` and Settings' `SignersSection`, so those change with it.
  return `Passkey · added ${formatLongDate(date)}`
}
