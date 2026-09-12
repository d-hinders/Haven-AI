import { en } from './messages/en'

/**
 * Lightweight, dependency-free i18n layer.
 *
 * `en` is the canonical catalog; `Messages` is its shape. The active catalog is
 * read through `useT()` (see context/LocaleContext) — leaves are strings or
 * interpolating functions, accessed by property so usage stays fully
 * type-checked.
 *
 * **The Haven dashboard ships one language (#2926).** The Swedish catalog, the Settings
 * language toggle and browser-language detection were removed on 2026-09-12:
 * only the accounting surface, Settings and the sidebar ever read the catalog
 * while the rest of the app is inline English, so a half-translated UI was
 * costing more than it delivered. What survives is the SHAPE — this module,
 * `Locale`, `LocaleProvider` and `useT()` — so a second language is a catalog
 * plus a locale value, not a refactor of every consumer.
 *
 * Adding one back means: a `messages/<locale>.ts` typed as `Messages` (the type
 * makes an untranslated key a compile error), the code in `LOCALES`, a tag in
 * `INTL_LOCALE`, some way to choose it, and a `lang` value that follows — and
 * then the formatters this module does NOT reach, below.
 *
 * Scope, stated so the list above is not read as complete: this is the
 * dashboard's message catalog. `packages/demo-merchant-mcp` has its own
 * Swedish output path behind an independent `locale` tool parameter, untouched
 * by #2926; and the backend's Swedish BOOKKEEPING domain (BAS, SIE, underlag,
 * VAT, SEK) is a market, not a language setting.
 */
export type Messages = typeof en

export const LOCALES = ['en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/**
 * BCP-47 tag each locale formats dates and relative times with — `Intl` needs a
 * region, `Locale` carries only the language. Deliberately a map rather than a
 * cast: `Record<Locale, string>` makes adding a code to `LOCALES` a compile
 * error until its tag exists.
 *
 * **It reaches exactly two call sites** — `ConnectionRow.formatConnectionDate`
 * and `FeedSummary.relativeTime`, the two that used to branch on `'sv'`. The
 * rest of the app's ~15 `Intl`/`toLocale*` calls format with a hard-coded
 * `'en-US'`, with the *device* locale (`undefined`), or bare, and none of them
 * consults this map. That is pre-existing drift, not something a second locale
 * would inherit cleanly: re-adding a language means auditing those too.
 */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB' }

export const messages: Record<Locale, Messages> = { en }
