import localFont from 'next/font/local'

/**
 * The public site's two added faces (#3573, epic decision 6): Inter Tight for
 * display type, JetBrains Mono for code. Body text stays the app's Inter,
 * inherited from `<body>`.
 *
 * They apply to new-site components ONLY. Each face is exposed as a CSS
 * variable (`--font-site-display`, `--font-site-mono`) that exists only below
 * an element carrying `SITE_FONT_VARIABLES`, and every new-site root carries
 * it — so the authenticated app, `packages/ui` and `packages/ops` cannot pick
 * either face up by accident. The CSP's `font-src 'self' data:` is unchanged.
 *
 * Local files, not `next/font/google`: the Google loader fetches at build time
 * and throws when Google answers with an extensionless font URL
 * (`loader.js`'s `/\.(woff|woff2|…)$/.exec(url)[1]`), which it did
 * intermittently for these two families and failed CI and local builds. The
 * files in `font-files/` are the OFL-1.1 latin variable (wght) cuts from
 * Fontsource 5.3.0 (`@fontsource-variable/inter-tight`,
 * `@fontsource-variable/jetbrains-mono`), licences beside them; the variable
 * axis covers every weight the type roles use.
 *
 * `preload: false` while the site gate exists: `SiteHeader` imports this
 * module whichever branch renders, so a preload would put a `<link
 * rel="preload">` for an unused face on every legacy page in production.
 * The switch-over slice (#3579) is where preloading becomes right.
 */
const display = localFont({
  src: './font-files/inter-tight-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-site-display',
  display: 'swap',
  preload: false,
})

const mono = localFont({
  src: './font-files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-site-mono',
  display: 'swap',
  preload: false,
})

/** Put on every new-site root element; defines the two font variables below it. */
export const SITE_FONT_VARIABLES = `${display.variable} ${mono.variable}`
