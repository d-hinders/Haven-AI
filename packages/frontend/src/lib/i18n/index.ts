import { en } from './messages/en'

/**
 * Lightweight, dependency-free i18n layer.
 *
 * `en` is the canonical catalog; `Messages` is its shape. The active catalog is
 * read through `useT()` (see context/LocaleContext) — leaves are strings or
 * interpolating functions, accessed by property so usage stays fully
 * type-checked.
 *
 * **Haven ships one language (#2926).** The Swedish catalog, the Settings
 * language toggle and browser-language detection were removed on 2026-09-12:
 * only the accounting surface, Settings and the sidebar ever read the catalog
 * while the rest of the app is inline English, so a half-translated UI was
 * costing more than it delivered. What survives is the SHAPE — this module,
 * `Locale`, `LocaleProvider` and `useT()` — so a second language is a catalog
 * plus a locale value, not a refactor of every consumer.
 *
 * Adding one back means: a `messages/<locale>.ts` typed as `Messages` (the type
 * makes an untranslated key a compile error), the code in `LOCALES`, a tag in
 * `INTL_LOCALE`, some way to choose it, and a `lang` value that follows.
 */
export type Messages = typeof en

export const LOCALES = ['en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/**
 * BCP-47 tag each locale formats dates and relative times with — `Intl` needs a
 * region, `Locale` carries only the language. Deliberately a map rather than a
 * cast: a second locale adds a line here instead of finding every `Intl` call.
 */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB' }

export const messages: Record<Locale, Messages> = { en }
