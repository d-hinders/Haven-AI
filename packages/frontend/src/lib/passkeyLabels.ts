/**
 * Credential row labels (#1679, copy-guidelines § "Name credentials
 * 'passkey', never a platform brand").
 *
 * "Passkey · added {date}" — the kind plus enrollment time, never a platform
 * brand and never positional: the positional variant ("Face ID / Touch ID"
 * for index 0, "Backup N" for the rest) misnamed the surviving backup as the
 * primary after a recovery removed the original key. No stored date → ordinal
 * "Passkey N" in enrollment order.
 */
export function passkeyRowLabel(createdAt: string | null | undefined, index: number): string {
  const date = createdAt ? new Date(createdAt) : null
  if (!date || Number.isNaN(date.getTime())) return `Passkey ${index + 1}`
  const formatted = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
  return `Passkey · added ${formatted}`
}
