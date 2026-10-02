/**
 * Formatting helpers the ops pages share (#3516).
 *
 * Every amount renders through `formatAtomic` so an atomic decimal string
 * crosses to display exactly once and the same way everywhere; the frontend's
 * per-page copies are deliberately NOT imported (the #3515 boundary), and a
 * third divergent copy is what this module exists to stop.
 */
import { getChainData } from '@haven_ai/core'

/** `1234567` (6 decimals) → `1.234567`; `0` → `0`. Pure string math — no float ever touches an atomic amount. */
export function formatAtomic(value: string, decimals: number): string {
  const digits = value.replace(/^-/, '')
  const negative = value.startsWith('-') && digits !== '0'
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '')
  const body = decimals > 0 && frac !== '' ? `${whole}.${frac}` : whole
  return negative ? `-${body}` : body
}

/** The chain's display name from the shared registry, or the raw id when unregistered. */
export function chainName(chainId: number): string {
  try {
    return getChainData(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

/** A relative age line for a fixed `now` — capture-stable, never a live timer. */
export function ageLine(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds}s`
  const minutes = Math.floor(ageSeconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 36) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} d`
}

/** An absolute UTC timestamp — ops reads facts, not "3 minutes ago". */
export function utcLine(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`
}

/** Unix seconds → the same absolute UTC line. */
export function unixLine(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—'
  return utcLine(new Date(seconds * 1000).toISOString())
}
