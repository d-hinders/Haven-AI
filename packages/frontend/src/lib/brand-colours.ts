/**
 * The four `globals.css` tokens the installed-app shell needs OUTSIDE a
 * stylesheet (#2729, #2763): `--v2-brand` / `--v2-bg` for the web manifest
 * and root layout metadata, `--v2-ink-on-brand` for the icon mark and badge
 * label, and `--v2-warning` for the dev icon's badge.
 *
 * A manifest is JSON and a `<meta>` is an attribute value — neither can say
 * `var(--v2-brand)`, so the values have to exist as strings here. They are NOT
 * a second source of truth: `installed-app.test.ts` parses `globals.css` and
 * fails the moment either side drifts, which is the whole point — a hex typo
 * here would be painted onto the status bar of every installed phone, and the
 * test is what makes that impossible to ship rather than merely unlikely.
 *
 * Why a test-pinned copy rather than reading the CSS at runtime: the deployed
 * server is Next's `output: 'standalone'` tree, which carries no `src/`, and
 * the root layout's metadata is resolved per request on dynamic routes. A
 * `readFileSync('src/app/globals.css')` there would crash every page the day
 * it first ran in production, having passed every local build.
 */
export const BRAND_COLOURS = {
  /** `--v2-brand` — manifest `theme_color`, `<meta name="theme-color">`. */
  brand: '#4f46e5',
  /** `--v2-ink-on-brand` — icon mark and warning badge label. */
  onBrand: '#ffffff',
  /** `--v2-bg` — manifest `background_color` (the splash behind the icon). */
  background: '#ffffff',
  /** `--v2-warning` — the dev install's icon badge, same tone as `EnvBadge`. */
  warning: '#b54708',
  /**
   * `--v2-bg` AS DECLARED IN THE DARK BLOCK — the value the status-bar pair
   * and the runtime override carry when the palette renders dark (#2928).
   *
   * Distinct from `background` although spelled alike: both are `--v2-bg`,
   * one is read from the `:root` block and this from the
   * `@media (prefers-color-scheme: dark)` block, and a manifest or a meta
   * can not read a custom property off a stylesheet. #2927's review verified
   * the two dark re-declaration blocks byte-identical (60 declarations each),
   * so parsing the media block alone is enough, and
   * `installed-app.test.ts` re-parses it to keep this string from drifting.
   */
  darkBackground: '#12151c',
} as const

/**
 * Which `globals.css` custom property each entry above is pinned to, and
 * from which block it is read. The four light entries are parsed from
 * `:root`; `darkBackground` is the one dark entry, parsed from the media
 * block, so it lives in its own map rather than in this one — a single map
 * keyed by token name could not say which block to read the token from, and
 * the whole point of the pin is that the test parses the RIGHT block.
 */
export const BRAND_COLOUR_TOKENS: Record<Exclude<keyof typeof BRAND_COLOURS, 'darkBackground'>, string> = {
  brand: '--v2-brand',
  onBrand: '--v2-ink-on-brand',
  background: '--v2-bg',
  warning: '--v2-warning',
}

/** The dark-palette entries and the token each is pinned to. */
export const DARK_BRAND_COLOUR_TOKENS: Record<Extract<keyof typeof BRAND_COLOURS, 'darkBackground'>, string> = {
  darkBackground: '--v2-bg',
}
