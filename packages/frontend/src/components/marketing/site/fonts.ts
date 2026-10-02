import { Inter_Tight, JetBrains_Mono } from 'next/font/google'

/**
 * The public site's two added faces (#3573, epic decision 6): Inter Tight for
 * display type, JetBrains Mono for code. Body text stays the app's Inter,
 * inherited from `<body>`.
 *
 * They apply to new-site components ONLY. Each face is exposed as a CSS
 * variable (`--font-site-display`, `--font-site-mono`) that exists only below
 * an element carrying `SITE_FONT_VARIABLES`, and every new-site root carries
 * it — so the authenticated app, `packages/ui` and `packages/ops` cannot pick
 * either face up by accident. `next/font` self-hosts the files at build time,
 * so the CSP's `font-src 'self' data:` is unchanged.
 *
 * `preload: false` while the site gate exists: `SiteHeader` imports this
 * module whichever branch renders, so a preload would put a `<link
 * rel="preload">` for an unused face on every legacy page in production.
 * The switch-over slice (#3579) is where preloading becomes right.
 */
const display = Inter_Tight({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-site-display',
  display: 'swap',
  preload: false,
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-site-mono',
  display: 'swap',
  preload: false,
})

/** Put on every new-site root element; defines the two font variables below it. */
export const SITE_FONT_VARIABLES = `${display.variable} ${mono.variable}`
