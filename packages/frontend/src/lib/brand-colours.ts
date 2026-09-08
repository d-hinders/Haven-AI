/**
 * The two `globals.css` tokens the installed-app shell needs OUTSIDE a
 * stylesheet (#2729): the web manifest's `theme_color` / `background_color`
 * and the `<meta name="theme-color">` the root layout emits, plus the warning
 * tone the dev icon's badge is painted in.
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
  /** `--v2-bg` — manifest `background_color` (the splash behind the icon). */
  background: '#ffffff',
  /** `--v2-warning` — the dev install's icon badge, same tone as `EnvBadge`. */
  warning: '#b54708',
} as const

/** Which `globals.css` custom property each entry above is pinned to. */
export const BRAND_COLOUR_TOKENS: Record<keyof typeof BRAND_COLOURS, string> = {
  brand: '--v2-brand',
  background: '--v2-bg',
  warning: '--v2-warning',
}
