import { en } from './messages/en'
import { sv } from './messages/sv'

/**
 * Lightweight, dependency-free i18n layer.
 *
 * `en` is the canonical catalog; `Messages` is its shape and every other locale
 * is typed against it, so adding a key in English without translating it (or
 * vice versa) is a compile error. The active catalog is read through
 * `useT()` (see context/LocaleContext) — leaves are strings or interpolating
 * functions, accessed by property so usage stays fully type-checked.
 */
export type Messages = typeof en

export const LOCALES = ['en', 'sv'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/** Persisted under this key (device-local; language is a per-device choice). */
export const LOCALE_STORAGE_KEY = 'haven.locale'

export const messages: Record<Locale, Messages> = { en, sv }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Map a BCP-47 tag (e.g. `sv-SE`) to a supported locale, or null if none. */
export function localeFromLanguageTag(tag: string | undefined | null): Locale | null {
  if (!tag) return null
  const primary = tag.toLowerCase().split('-')[0]
  return isLocale(primary) ? primary : null
}
